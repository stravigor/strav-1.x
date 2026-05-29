/**
 * `AnthropicProvider` — implementation of `Provider` backed by the
 * official `@anthropic-ai/sdk`.
 *
 * Responsibilities:
 *   1. Hold a singleton `Anthropic` client instance for the
 *      configured API key + base URL.
 *   2. Translate the framework's `ChatOptions` / `Message` shapes
 *      into Anthropic's `MessageCreateParams` (system as `TextBlock[]`
 *      with `cache_control` when requested; messages with per-block
 *      cache flags translated likewise; `thinking` mapped to
 *      `ThinkingConfigParam`; `effort` placed under `output_config`).
 *   3. Translate the response back to `ChatResult` — flatten the
 *      content blocks into a single `text` string, surface usage with
 *      cache-hit counters, and pass the raw `Message` through on `.raw`.
 *   4. Stream via `client.messages.stream()` and yield the framework
 *      `StreamEvent` union — `text` deltas plus a terminal `stop`
 *      event with usage + stop reason.
 *
 * Errors from the SDK propagate; apps that want provider-specific
 * recovery can `instanceof Anthropic.RateLimitError` etc. The brain
 * facade wraps the call site in `BrainError` only for invariants the
 * facade owns (e.g. "no provider configured").
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from '../agent_result.ts'
import type { AnthropicProviderConfig } from '../brain_config.ts'
import { DEFAULT_MODEL } from '../brain_config.ts'
import type { Provider, RunWithToolsOptions } from '../provider.ts'
import type { Tool } from '../tool.ts'
import { ToolExecutionError } from '../tool_execution_error.ts'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  Message,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.ts'

const EPHEMERAL_CACHE = { type: 'ephemeral' } as const

export class AnthropicProvider implements Provider {
  readonly name: string
  private readonly client: Anthropic
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number
  private readonly betas: readonly string[]

  constructor(
    name: string,
    config: AnthropicProviderConfig,
    options: { client?: Anthropic } = {},
  ) {
    this.name = name
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096
    this.betas = config.betas ?? []
    // `client` injection point — tests pass a stub; apps that want a
    // pre-configured SDK instance (custom retry, fetch transport, etc.)
    // build their own and hand it over here.
    this.client =
      options.client ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
      })
  }

  async chat(messages: readonly Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const params = this.buildParams(messages, options)
    const response = await this.client.messages.create(params)
    return this.toChatResult(response)
  }

  async *stream(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const params = this.buildParams(messages, options)
    const stream = this.client.messages.stream(params)
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'text', delta: event.delta.text }
      }
    }
    const final = await stream.finalMessage()
    yield {
      type: 'stop',
      stopReason: final.stop_reason,
      usage: toUsage(final.usage),
    }
  }

  async countTokens(
    messages: readonly Message[],
    options: ChatOptions = {},
  ): Promise<number> {
    const base = this.buildParams(messages, options)
    // count_tokens only accepts a subset of MessageCreateParams; build
    // a focused payload that matches what apps actually need to budget.
    const result = await this.client.messages.countTokens({
      model: base.model,
      messages: base.messages,
      ...(base.system !== undefined ? { system: base.system } : {}),
      ...(base.thinking !== undefined ? { thinking: base.thinking } : {}),
    })
    return result.input_tokens
  }

  /**
   * Agentic loop. Send → detect tool_use blocks → execute → append
   * tool_result → re-send, until the model returns `end_turn` or
   * the iteration ceiling is hit.
   *
   * Tools are passed once on every call — Anthropic doesn't carry
   * tool state across requests; the model rediscovers them from the
   * `tools` array each turn. Apps that care about cache hits keep
   * the tool list stable across runs.
   */
  async runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options: RunWithToolsOptions = {},
  ): Promise<AgentResult> {
    const maxIterations = options.maxIterations ?? 10
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    const workingMessages: Message[] = [...messages]
    const aggregated: ChatUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    let iterations = 0
    let lastStopReason: string | null = null

    while (true) {
      const params = this.buildParams(workingMessages, options)
      params.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }))

      const response = await this.client.messages.create(params)
      addUsage(aggregated, response.usage)
      lastStopReason = response.stop_reason ?? null

      // Append the assistant turn verbatim from the SDK shape so
      // tool_use blocks survive to the next request unchanged.
      workingMessages.push({
        role: 'assistant',
        content: fromAnthropicContent(response.content),
      })

      if (response.stop_reason !== 'tool_use') {
        return {
          text: collectText(response.content),
          messages: workingMessages,
          iterations,
          stopReason: lastStopReason ?? 'end_turn',
          usage: aggregated,
        }
      }

      // Execute every tool_use block in the response and append the
      // results in a single user-role turn. The SDK's API expects all
      // tool_result blocks for a given assistant turn to land in the
      // same user message.
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      const resultBlocks: ContentBlock[] = []
      for (const block of toolUseBlocks) {
        const tool = toolMap.get(block.name)
        if (!tool) {
          throw new ToolExecutionError(
            block.name,
            block.id,
            new Error(`Tool "${block.name}" is not registered.`),
          )
        }
        let output: unknown
        try {
          output = await tool.execute(block.input, {
            callId: block.id,
            context: options.context ?? {},
          })
        } catch (cause) {
          throw new ToolExecutionError(block.name, block.id, cause)
        }
        const resultBlock: ToolResultBlock = {
          type: 'tool_result',
          toolUseId: block.id,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        }
        resultBlocks.push(resultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        return {
          text: collectText(response.content),
          messages: workingMessages,
          iterations,
          stopReason: 'max_iterations',
          usage: aggregated,
        }
      }
    }
  }

  // ─── Param translation ──────────────────────────────────────────────────

  private buildParams(
    messages: readonly Message[],
    options: ChatOptions,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const model = options.model ?? this.defaultModel
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      messages: messages.map(toMessageParam),
    }

    const system = toSystemParam(options.system)
    if (system !== undefined) params.system = system

    if (options.thinking === 'adaptive') {
      params.thinking = { type: 'adaptive' }
    } else if (options.thinking === 'disabled') {
      params.thinking = { type: 'disabled' }
    }

    if (options.effort !== undefined) {
      params.output_config = { effort: options.effort }
    }

    if (options.cache === true) {
      // Top-level auto-cache the last cacheable block. Maps to the
      // SDK's `cache_control` shorthand on the request body.
      ;(params as { cache_control?: { type: 'ephemeral' } }).cache_control = EPHEMERAL_CACHE
    }

    const betas = mergeBetas(this.betas, options.betas)
    if (betas.length > 0) {
      ;(params as { betas?: readonly string[] }).betas = betas
    }

    return params
  }

  private toChatResult(message: Anthropic.Message): ChatResult<Anthropic.Message> {
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return {
      text,
      model: message.model,
      stopReason: message.stop_reason,
      usage: toUsage(message.usage),
      raw: message,
    }
  }
}

// ─── Shape converters ─────────────────────────────────────────────────────

function toUsage(u: Anthropic.Usage): ChatUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  }
}

function toMessageParam(message: Message): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content }
  }
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        }
      }
      if (block.type === 'tool_result') {
        const param: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content:
            typeof block.content === 'string'
              ? block.content
              : block.content.map((b) => ({ type: 'text', text: b.text }) as Anthropic.TextBlockParam),
        }
        if (block.isError) param.is_error = true
        return param
      }
      const text: Anthropic.TextBlockParam = { type: 'text', text: block.text }
      if (block.cache) text.cache_control = EPHEMERAL_CACHE
      return text
    }),
  }
}

function toSystemParam(
  system: SystemPrompt | undefined,
): string | Anthropic.TextBlockParam[] | undefined {
  if (system === undefined) return undefined
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((block) => {
      const param: Anthropic.TextBlockParam = { type: 'text', text: block.text }
      if (block.cache) param.cache_control = EPHEMERAL_CACHE
      return param
    })
  }
  const param: Anthropic.TextBlockParam = { type: 'text', text: system.text }
  if (system.cache) param.cache_control = EPHEMERAL_CACHE
  return [param]
}

function mergeBetas(
  providerBetas: readonly string[],
  callBetas: readonly string[] | undefined,
): readonly string[] {
  if (!callBetas || callBetas.length === 0) return providerBetas
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of providerBetas) {
    if (seen.has(b)) continue
    seen.add(b)
    out.push(b)
  }
  for (const b of callBetas) {
    if (seen.has(b)) continue
    seen.add(b)
    out.push(b)
  }
  return out
}

function addUsage(acc: ChatUsage, u: Anthropic.Usage): void {
  acc.inputTokens += u.input_tokens
  acc.outputTokens += u.output_tokens
  acc.cacheReadTokens += u.cache_read_input_tokens ?? 0
  acc.cacheCreationTokens += u.cache_creation_input_tokens ?? 0
}

function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Translate the SDK's response content blocks back into framework
 * `ContentBlock`s for storage in `workingMessages`. We preserve
 * `text` and `tool_use` blocks verbatim; other server-side block
 * types (thinking, server tool blocks) are dropped — V1 doesn't
 * surface them, and re-sending them as part of the assistant turn
 * could confuse the model.
 */
function fromAnthropicContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text } satisfies TextBlock)
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      } satisfies ToolUseBlock)
    }
  }
  return out
}
