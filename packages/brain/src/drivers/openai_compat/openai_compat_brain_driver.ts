/**
 * `OpenAICompatBrainDriver` — abstract intermediate that captures the
 * "OpenAI-compatible local / third-party endpoint" pattern shared by
 * `DeepSeekBrainDriver`, `OllamaBrainDriver`, and anything else (Groq,
 * Together, Fireworks, vLLM, llama.cpp's server, …) that exposes a
 * `/v1/chat/completions` surface that is request-/response-shape-
 * identical to OpenAI's.
 *
 * What it does, factored out of OpenAIBrainDriver:
 *
 *   - **Strips `reasoning_effort`.** Compat endpoints typically
 *     reject unknown fields. `buildParams` removes it on every
 *     request. Subclasses that target a vendor which DOES support
 *     `reasoning_effort` re-add it in their own `buildParams`
 *     override.
 *
 *   - **`generate` via `json_object` + schema-in-system-prompt.**
 *     The OpenAI provider uses `response_format.json_schema` with
 *     `strict: true` — most OpenAI-compat vendors don't support
 *     that. The safe default is `json_object` mode + a
 *     "Respond with JSON matching this schema" instruction
 *     injected into the system prompt, then client-side
 *     `parseGenerated` validates.
 *
 *   - **Throws on combined tools + schema.** No reliable per-turn
 *     schema enforcement on compat endpoints in V1.
 *     `runWithToolsAndSchema` / `streamWithToolsAndSchema` throw
 *     `BrainError` with a clear "run as two calls or switch
 *     providers" message.
 *
 *   - **`mapUsage` hook.** Default just maps OpenAI's
 *     `prompt_tokens` / `completion_tokens` straight across. Vendors
 *     that report cache hits on a custom field (DeepSeek does;
 *     `prompt_cache_hit_tokens`) override.
 *
 * Subclasses provide just the constructor + (sometimes) a
 * `mapUsage` override. Most named compat providers in this
 * codebase are now <40 lines.
 */

import type OpenAI from 'openai'
import type { AgentGenerateResult } from '../../agent_generate_result.ts'
import type { AgentStreamEvent } from '../../agent_stream_event.ts'
import { BrainError } from '../../brain_error.ts'
import { parseGenerated, type OutputSchema } from '../../output_schema.ts'
import type { RunWithToolsOptions } from '../../brain_driver.ts'
import type { Tool } from '../../tool.ts'
import { recoverOrThrow, runToolWithRecovery } from '../../tool_runner.ts'
import { ToolExecutionError } from '../../tool_execution_error.ts'
import type {
  ChatOptions,
  ChatUsage,
  ContentBlock,
  GenerateResult,
  Message,
  SystemPrompt,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types.ts'
import { OpenAIBrainDriver } from '../openai/openai_brain_driver.ts'

export abstract class OpenAICompatBrainDriver extends OpenAIBrainDriver {
  /**
   * Same as the OpenAI build but strips `reasoning_effort` — most
   * compat endpoints reject unknown fields. Subclasses that target
   * a vendor which DOES accept `reasoning_effort` override this
   * and either skip the strip or call `super.buildParams` and
   * re-add it.
   */
  protected override buildParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const params = super.buildParams(messages, options, tools)
    if ('reasoning_effort' in params) {
      delete (params as { reasoning_effort?: unknown }).reasoning_effort
    }
    return params
  }

  /**
   * `generate` injects the JSON Schema into the system prompt as a
   * "respond with JSON matching this schema" instruction, sets
   * `response_format: { type: 'json_object' }`, and validates the
   * response client-side via `parseGenerated`. Apps that supply
   * `schema.parse` get the same runtime validation as on the
   * other providers; without it, the value is `T` by type
   * assertion only.
   *
   * Caveat: unlike OpenAI's `strict: true` json_schema mode, the
   * upstream API doesn't enforce the schema. Smaller models may
   * hallucinate; `parseGenerated` catches it at the boundary.
   */
  override async generate<T>(
    messages: readonly Message[],
    schema: OutputSchema<T>,
    options: ChatOptions = {},
  ): Promise<GenerateResult<T>> {
    const augmented: ChatOptions = {
      ...options,
      system: combineSystem(options.system, schemaInstruction(schema)),
    }
    const params = this.buildParams(messages, augmented, [])
    params.response_format = { type: 'json_object' }
    const response = await this.client.chat.completions.create(
      params,
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
    const choice = response.choices[0]
    const text = choice?.message?.content ?? ''
    const value = parseGenerated(text, schema)
    return {
      value,
      text,
      model: response.model,
      stopReason: choice?.finish_reason ?? null,
      usage: this.mapUsage(response.usage),
      raw: response,
    }
  }

  /**
   * Combined tool-loop + structured output via the **tool-forcing**
   * pattern. OpenAI-compat endpoints don't support per-turn
   * `json_schema` enforcement, but they do support OpenAI-style
   * function calling — so the framework injects a synthetic
   * `respond_with_<schemaName>` tool whose JSON-Schema
   * `parameters` IS the desired output schema. The model uses it
   * (and only it) for its final answer; the args become the
   * parsed structured value. Regular tools work normally
   * alongside.
   *
   * The model is prompted to call regular tools first, then
   * `respond_with` exactly once when ready to answer. If it
   * doesn't (returns plain text instead, or hits `maxIterations`),
   * the framework throws `BrainError` — apps should reinforce the
   * pattern via a clearer system prompt, or simplify the task.
   *
   * Caveats vs OpenAI's `strict: true`:
   *   - Smaller models may emit invalid JSON in the tool args.
   *     `parseGenerated` + the optional `schema.parse` hook catch
   *     it at the boundary.
   *   - Schema features beyond OpenAI function-calling's subset
   *     (recursive refs, advanced keywords) may not be honored.
   *     Stick to flat object schemas for best results.
   */
  override async runWithToolsAndSchema<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions = {},
  ): Promise<AgentGenerateResult<T>> {
    const resolved = await this.resolveMcp(options.mcpServers ?? [])
    try {
      return await this._toolForcingLoop(
        messages,
        [...tools, ...resolved.tools],
        schema,
        options,
      )
    } finally {
      await resolved.close()
    }
  }

  override async *streamWithToolsAndSchema<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions = {},
  ): AsyncIterable<AgentStreamEvent<T>> {
    const resolved = await this.resolveMcp(options.mcpServers ?? [])
    try {
      yield* this._toolForcingStream(
        messages,
        [...tools, ...resolved.tools],
        schema,
        options,
      )
    } finally {
      await resolved.close()
    }
  }

  private async _toolForcingLoop<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>> {
    const { respondTool, respondName, augmented } = prepareToolForcing(schema, options, tools)
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

    while (true) {
      checkAborted(options.signal)
      const params = this.buildParams(workingMessages, augmented, tools)
      params.tools = [...(params.tools ?? []), respondTool]
      const response = await this.client.chat.completions.create(
        params,
        reqOpts(options),
      )
      addUsageHere(aggregated, response.usage, this)

      const choice = response.choices[0]
      if (!choice) {
        throw new BrainError(
          `${this.name}.runWithToolsAndSchema: response had no choices.`,
        )
      }
      const assistantMessage = choice.message
      workingMessages.push({
        role: 'assistant',
        content: fromOpenAIAssistant(assistantMessage),
      })

      const toolCalls = assistantMessage.tool_calls ?? []
      const respond = toolCalls.find(
        (c) => c.type === 'function' && c.function.name === respondName,
      )
      if (respond && respond.type === 'function') {
        const text = respond.function.arguments ?? ''
        const value = parseGenerated(text, schema)
        return {
          value,
          text,
          messages: workingMessages,
          iterations,
          stopReason: choice.finish_reason ?? 'stop',
          usage: aggregated,
        }
      }

      if (toolCalls.length === 0 || choice.finish_reason !== 'tool_calls') {
        throw new BrainError(
          `${this.name}.runWithToolsAndSchema: model returned without calling \`${respondName}\`. Add a stronger instruction in the system prompt — apps must steer the model to use the synthetic respond tool for its final answer.`,
          { context: { provider: this.name, text: assistantMessage.content ?? '' } },
        )
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        if (call.type !== 'function') continue
        let parsedInput: unknown
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch (err) {
          parseFailed = recoverOrThrow(
            new ToolExecutionError(
              call.function.name,
              call.id,
              new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
            ),
            options,
          )
        }
        const { content, isError } = parseFailed
          ?? (await runToolWithRecovery(
            toolMap.get(call.function.name),
            call.function.name,
            call.id,
            parsedInput,
            options,
          ))
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        throw new BrainError(
          `${this.name}.runWithToolsAndSchema: hit maxIterations (${maxIterations}) without the model calling \`${respondName}\`. Bump maxIterations, simplify the task, or strengthen the system-prompt nudge.`,
          { context: { provider: this.name } },
        )
      }
    }
  }

  private async *_toolForcingStream<T>(
    messages: readonly Message[],
    tools: readonly Tool[],
    schema: OutputSchema<T>,
    options: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<T>> {
    const { respondTool, respondName, augmented } = prepareToolForcing(schema, options, tools)
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

    while (true) {
      checkAborted(options.signal)
      yield { type: 'iteration_start', iteration: iterations }

      const baseParams = this.buildParams(workingMessages, augmented, tools)
      baseParams.tools = [...(baseParams.tools ?? []), respondTool]
      const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        ...baseParams,
        stream: true,
        stream_options: { include_usage: true },
      }
      const stream = await this.client.chat.completions.create(params, reqOpts(options))

      let textBuf = ''
      const toolCallsByIndex = new Map<
        number,
        { id?: string; name?: string; args: string; started: boolean }
      >()
      let finishReason: string | null = null
      let lastUsage: OpenAI.CompletionUsage | undefined

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        const delta = choice?.delta
        if (delta?.content && typeof delta.content === 'string' && delta.content.length > 0) {
          textBuf += delta.content
          yield { type: 'text', delta: delta.content }
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const entry = toolCallsByIndex.get(tc.index) ?? { args: '', started: false }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            toolCallsByIndex.set(tc.index, entry)
            if (!entry.started && entry.id !== undefined && entry.name !== undefined) {
              entry.started = true
              if (entry.name !== respondName) {
                yield { type: 'tool_use_start', id: entry.id, name: entry.name }
              }
            }
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments
              if (
                entry.started &&
                entry.id !== undefined &&
                entry.name !== respondName
              ) {
                yield {
                  type: 'tool_use_delta',
                  id: entry.id,
                  argsDelta: tc.function.arguments,
                }
              }
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) lastUsage = chunk.usage
      }

      addUsageHere(aggregated, lastUsage, this)
      yield { type: 'iteration_end', iteration: iterations, stopReason: finishReason }

      const assistantBlocks: ContentBlock[] = []
      if (textBuf.length > 0) assistantBlocks.push({ type: 'text', text: textBuf })
      const orderedCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v)
      for (const call of orderedCalls) {
        if (!call.id || !call.name) continue
        let parsedInput: unknown = {}
        try {
          parsedInput = call.args ? JSON.parse(call.args) : {}
        } catch {
          parsedInput = call.args
        }
        assistantBlocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parsedInput,
        } satisfies ToolUseBlock)
      }
      const assistantContent: string | ContentBlock[] =
        assistantBlocks.length === 1 && assistantBlocks[0]?.type === 'text'
          ? assistantBlocks[0].text
          : assistantBlocks
      workingMessages.push({ role: 'assistant', content: assistantContent })

      const respond = orderedCalls.find((c) => c.name === respondName)
      if (respond && respond.id) {
        const text = respond.args
        const value = parseGenerated(text, schema)
        yield {
          type: 'stop',
          stopReason: finishReason ?? 'stop',
          iterations,
          usage: aggregated,
          messages: workingMessages,
          value,
          text,
        } as AgentStreamEvent<T>
        return
      }

      if (finishReason !== 'tool_calls' || orderedCalls.length === 0) {
        throw new BrainError(
          `${this.name}.streamWithToolsAndSchema: model returned without calling \`${respondName}\`. Strengthen the system-prompt nudge.`,
          { context: { provider: this.name, text: textBuf } },
        )
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of orderedCalls) {
        if (!call.id || !call.name) continue
        let parsedInput: unknown
        let parseFailed: { content: string; isError: boolean } | undefined
        try {
          parsedInput = call.args ? JSON.parse(call.args) : {}
        } catch (err) {
          parseFailed = recoverOrThrow(
            new ToolExecutionError(
              call.name,
              call.id,
              new Error(`Failed to parse tool input JSON: ${(err as Error).message}`),
            ),
            options,
          )
          parsedInput = call.args
        }
        yield { type: 'tool_use', id: call.id, name: call.name, input: parsedInput }
        const { content, isError } = parseFailed
          ?? (await runToolWithRecovery(
            toolMap.get(call.name),
            call.name,
            call.id,
            parsedInput,
            options,
          ))
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        } satisfies ToolResultBlock)
        yield { type: 'tool_result', id: call.id, name: call.name, content, isError }
      }
      workingMessages.push({ role: 'user', content: resultBlocks })

      iterations++
      if (iterations >= maxIterations) {
        throw new BrainError(
          `${this.name}.streamWithToolsAndSchema: hit maxIterations (${maxIterations}) without the model calling \`${respondName}\`.`,
          { context: { provider: this.name } },
        )
      }
    }
  }

  /**
   * Hook for subclasses to extract usage from a vendor-specific
   * `CompletionUsage` extension. Default maps OpenAI's standard
   * `prompt_tokens` / `completion_tokens` /
   * `prompt_tokens_details.cached_tokens` shape. DeepSeek reads
   * `prompt_cache_hit_tokens`; Ollama leaves cache fields at 0.
   */
  protected mapUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage {
    return {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreationTokens: 0,
    }
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────

/** Merge an additional instruction into an existing system prompt. */
function combineSystem(existing: SystemPrompt | undefined, addition: string): SystemPrompt {
  if (existing === undefined) return addition
  if (typeof existing === 'string') return `${existing}\n\n${addition}`
  if (Array.isArray(existing)) return [...existing, { text: addition }]
  return [existing, { text: addition }]
}

/** Build the system-prompt fragment that pins the model to the supplied JSON schema. */
function schemaInstruction(schema: OutputSchema<unknown>): string {
  const lines = [
    `Respond with a JSON object that matches the following JSON Schema. Output ONLY the JSON object — no prose, no markdown fences.`,
    schema.description ? `Schema description: ${schema.description}` : undefined,
    `Schema (name: ${schema.name}):`,
    JSON.stringify(schema.jsonSchema, null, 2),
  ].filter((s): s is string => s !== undefined)
  return lines.join('\n')
}

// ─── Tool-forcing helpers ────────────────────────────────────────────────

const RESPOND_TOOL_PREFIX = 'respond_with_'

/**
 * Build the synthetic respond-tool entry + the system-prompt nudge
 * apps inject alongside their own system message. Validates that
 * the chosen tool name doesn't collide with any user tool — that
 * would make the loop's terminal detection ambiguous.
 */
function prepareToolForcing(
  schema: OutputSchema<unknown>,
  options: ChatOptions,
  userTools: readonly Tool[],
): {
  respondTool: OpenAI.Chat.ChatCompletionTool
  respondName: string
  augmented: ChatOptions
} {
  const respondName = `${RESPOND_TOOL_PREFIX}${schema.name}`
  if (userTools.some((t) => t.name === respondName)) {
    throw new BrainError(
      `OpenAICompatBrainDriver.runWithToolsAndSchema: synthetic tool name "${respondName}" collides with a user-supplied tool. Rename your tool or the OutputSchema.name to avoid the clash.`,
      { context: { conflictingName: respondName } },
    )
  }
  const respondTool: OpenAI.Chat.ChatCompletionTool = {
    type: 'function',
    function: {
      name: respondName,
      description:
        `Submit your final answer. Call this exactly once, after using any other tools you need. ` +
        `The arguments MUST conform to the schema below. Do not return prose alongside or in place of this call.` +
        (schema.description ? ` (${schema.description})` : ''),
      parameters: schema.jsonSchema as Record<string, unknown>,
    },
  }
  const augmented: ChatOptions = {
    ...options,
    system: combineSystem(options.system, toolForcingInstruction(respondName)),
  }
  return { respondTool, respondName, augmented }
}

function toolForcingInstruction(respondName: string): string {
  return [
    `When you are ready to give the final answer, call the \`${respondName}\` function with the structured arguments.`,
    `Use any other available tools first to gather what you need. Once you have enough information, call \`${respondName}\` exactly once and do NOT also return prose text.`,
  ].join(' ')
}

function reqOpts(options: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return options.signal !== undefined ? { signal: options.signal } : undefined
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

function fromOpenAIAssistant(
  msg: OpenAI.Chat.ChatCompletionMessage,
): string | ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (msg.content) blocks.push({ type: 'text', text: msg.content })
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue
      let parsedInput: unknown = {}
      try {
        parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        parsedInput = call.function.arguments ?? {}
      }
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parsedInput,
      } satisfies ToolUseBlock)
    }
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text
  return blocks
}

/**
 * Add provider-mapped usage onto an accumulator. Calls `mapUsage`
 * on the provider instance so subclasses (e.g., DeepSeek) honor
 * their vendor-specific cache fields.
 */
function addUsageHere(
  acc: ChatUsage,
  u: OpenAI.CompletionUsage | undefined,
  provider: OpenAICompatBrainDriver,
): void {
  if (!u) return
  // Cast: `mapUsage` is protected on the abstract class; we're
  // inside the module so the access is valid at runtime.
  const mapped = (provider as unknown as {
    mapUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage
  }).mapUsage(u)
  acc.inputTokens += mapped.inputTokens
  acc.outputTokens += mapped.outputTokens
  acc.cacheReadTokens += mapped.cacheReadTokens
  acc.cacheCreationTokens += mapped.cacheCreationTokens
}
