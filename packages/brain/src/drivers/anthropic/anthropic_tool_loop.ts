/**
 * Shared non-streaming tool-loop iteration for Anthropic.
 *
 * Mirrors `openai_tool_loop.ts` — extracts the per-iteration body
 * so `runWithTools` and `runWithToolsAndSchema` become thin
 * orchestrators that only encode their own terminal return shape
 * (`AgentResult | SuspendedRun` vs `AgentGenerateResult<T>`).
 *
 * Also exports `injectToolsAndMCP`, the local-tools + MCP-toolset +
 * beta-header injection block that both runners apply after
 * `buildParams`. Anthropic's MCP connector requires the
 * `mcp-client-2025-11-20` beta header; the injector flips it
 * automatically when MCP servers are declared.
 *
 * Streaming variants are not unified here — same rationale as
 * OpenAI: yielding events mid-iteration requires an async-generator
 * wrapper with reader-complexity cost that outweighs the LOC win.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { RunWithToolsOptions } from '../../brain_driver.ts'
import type { MCPServer } from '../../mcp_server.ts'
import type { Tool } from '../../tool.ts'
import { runToolWithRecovery } from '../../tool_runner.ts'
import type {
  ChatUsage,
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types.ts'
import {
  checkAborted,
  collectText,
  needsBetaRouting,
  reqOpts,
} from './anthropic_helpers.ts'
import {
  addAnthropicUsage,
  fromAnthropicContent,
} from './anthropic_response_mapper.ts'

const MCP_BETA = 'mcp-client-2025-11-20'

/** Params shape with the optional MCP-beta field surfaced for inline mutation. */
type ParamsWithMcp = Anthropic.MessageCreateParamsNonStreaming & {
  mcp_servers?: Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition[]
}

/**
 * Inject local tools + MCP toolsets into `params.tools`, declare MCP
 * servers, and flip the `mcp-client-2025-11-20` beta header when MCP
 * is in play. Mutates `params` in place; returns the same reference
 * for chaining.
 *
 * Both runners call this once per iteration after `buildParams` and
 * after any runner-specific augmentation (e.g. `output_config.format`
 * for the schema variant).
 */
export function injectToolsAndMCP(
  params: Anthropic.MessageCreateParamsNonStreaming,
  args: { tools: readonly Tool[]; mcpServers: readonly MCPServer[] },
): ParamsWithMcp {
  const p = params as ParamsWithMcp
  p.tools = [
    // Server tools placed first when present (from buildParams).
    ...((p.tools ?? []) as Anthropic.ToolUnion[]),
    ...args.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })),
    // MCP toolsets — one per declared server. The model sees the
    // server's tools via Anthropic's connector, not via our local
    // `tools` list.
    ...args.mcpServers
      .filter((s) => s.tools?.enabled !== false)
      .map((s) => ({
        type: 'mcp_toolset' as const,
        mcp_server_name: s.name,
        ...(s.tools?.allowedTools ? { allowed_tools: [...s.tools.allowedTools] } : {}),
      })),
  ] as unknown as Anthropic.MessageCreateParams['tools']

  if (args.mcpServers.length > 0) {
    p.mcp_servers = args.mcpServers.map((s) => {
      const def: Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition = {
        type: 'url',
        name: s.name,
        url: s.url,
      }
      if (s.authorizationToken !== undefined) def.authorization_token = s.authorizationToken
      return def
    })
    const baseBetas = (p as { betas?: readonly string[] }).betas ?? []
    ;(p as { betas?: string[] }).betas = baseBetas.includes(MCP_BETA)
      ? [...baseBetas]
      : [...baseBetas, MCP_BETA]
  }
  return p
}

/** Per-iteration mutable state. The helper mutates this in place. */
export interface NonStreamLoopState {
  workingMessages: Message[]
  aggregated: ChatUsage
  iterations: number
  lastStopReason: string | null
}

export function createNonStreamLoopState(messages: readonly Message[]): NonStreamLoopState {
  return {
    workingMessages: [...messages],
    aggregated: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    iterations: 0,
    lastStopReason: null,
  }
}

/**
 * Per-iteration outcome the orchestrator branches on. `assistantText`
 * is `collectText(response.content)` — the schema variant feeds it
 * through `parseGenerated`; the plain variant returns it as-is.
 */
export type NonStreamIterationOutcome =
  | { kind: 'continue' }
  | { kind: 'stop'; assistantText: string; stopReason: string }
  | { kind: 'max_iterations'; assistantText: string }
  | { kind: 'suspended'; pendingToolCalls: ToolUseBlock[] }

export interface NonStreamIterationArgs {
  state: NonStreamLoopState
  toolMap: Map<string, Tool>
  maxIterations: number
  client: Anthropic
  /**
   * Built per iteration because `workingMessages` grows each round.
   * Schema variant's closure adds `output_config.format: json_schema`
   * after the driver's base `buildParams` runs. Caller is responsible
   * for the `injectToolsAndMCP` step.
   */
  buildParams: (msgs: readonly Message[]) => Anthropic.MessageCreateParamsNonStreaming
  options: RunWithToolsOptions
  /**
   * Human-in-the-loop gate. Pass `options.shouldSuspend` to enable;
   * pass `undefined` to disable (schema callers don't support
   * suspension).
   */
  suspendCheck: NonNullable<RunWithToolsOptions['shouldSuspend']> | undefined
}

/**
 * One round-trip of the Anthropic agentic loop. Routes through the
 * beta surface when MCP servers or compaction are in play; otherwise
 * stays on the stable `client.messages.create`. Returns a
 * discriminated outcome the orchestrator branches on; `state` is
 * mutated in place.
 */
export async function runAnthropicNonStreamIteration(
  args: NonStreamIterationArgs,
): Promise<NonStreamIterationOutcome> {
  const { state, toolMap, maxIterations, client, buildParams, options, suspendCheck } = args
  checkAborted(options.signal)
  const params = buildParams(state.workingMessages)

  // Route via beta when MCP servers OR compaction are in play.
  const response: Anthropic.Message = needsBetaRouting(params)
    ? ((await client.beta.messages.create(
        params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
        reqOpts(options),
      )) as unknown as Anthropic.Message)
    : await client.messages.create(params, reqOpts(options))
  addAnthropicUsage(state.aggregated, response.usage)
  state.lastStopReason = response.stop_reason ?? null

  // Append the assistant turn verbatim from the SDK shape so tool_use
  // blocks survive to the next request unchanged.
  state.workingMessages.push({
    role: 'assistant',
    content: fromAnthropicContent(response.content),
  })

  const assistantText = collectText(response.content)

  if (response.stop_reason !== 'tool_use') {
    return {
      kind: 'stop',
      assistantText,
      stopReason: state.lastStopReason ?? 'end_turn',
    }
  }

  // Execute every tool_use block; all results land in one user turn
  // per the SDK contract.
  const toolUseBlocks = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  )
  const resultBlocks: ContentBlock[] = []
  for (let i = 0; i < toolUseBlocks.length; i++) {
    const block = toolUseBlocks[i]!
    if (suspendCheck) {
      const frameworkCall: ToolUseBlock = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }
      if (await suspendCheck(frameworkCall, options.context)) {
        return {
          kind: 'suspended',
          pendingToolCalls: toolUseBlocks.slice(i).map((b) => ({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input as Record<string, unknown>,
          })),
        }
      }
    }
    const { content, isError } = await runToolWithRecovery(
      toolMap.get(block.name),
      block.name,
      block.id,
      block.input,
      options,
    )
    resultBlocks.push({
      type: 'tool_result',
      toolUseId: block.id,
      content,
      ...(isError ? { isError: true } : {}),
    } satisfies ToolResultBlock)
  }
  state.workingMessages.push({ role: 'user', content: resultBlocks })

  state.iterations++
  if (state.iterations >= maxIterations) {
    return { kind: 'max_iterations', assistantText }
  }
  return { kind: 'continue' }
}
