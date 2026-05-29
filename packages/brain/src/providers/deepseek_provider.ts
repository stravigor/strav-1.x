/**
 * `DeepSeekProvider` — implementation of `Provider` backed by the
 * `openai` SDK pointed at DeepSeek's OpenAI-compatible chat
 * completions endpoint.
 *
 * Inherits from `OpenAIProvider` because the request / response
 * shapes are 1:1 with OpenAI's. Only three things diverge:
 *
 *   - **Default base URL + model.** `https://api.deepseek.com/v1` +
 *     `deepseek-chat`. Apps point at `deepseek-reasoner` (R1) for
 *     thinking-mode tasks.
 *
 *   - **No `reasoning_effort`.** DeepSeek's API rejects unknown
 *     fields; the OpenAI provider would emit `reasoning_effort`
 *     when `options.thinking` / `options.effort` is set, so we
 *     override `buildParams` to strip it. `deepseek-reasoner`
 *     emits its own thinking tokens regardless of the absent
 *     control field.
 *
 *   - **No `response_format.json_schema`.** DeepSeek supports only
 *     `response_format.json_object` — the model produces JSON but
 *     the API doesn't enforce a schema upstream. `generate()`
 *     compensates by injecting the schema into the system prompt
 *     and validating the response client-side via
 *     `parseGenerated`. Combined tools+schema (which would need
 *     per-turn schema enforcement) is deferred — `runWithToolsAndSchema`
 *     and `streamWithToolsAndSchema` throw with a clear "use
 *     `runTools` + a separate `generate` call" message.
 *
 * Same `mcpServers` handling via the local `@strav/brain/mcp`
 * client (DeepSeek has no server-side MCP). Apps targeting both
 * OpenAI + DeepSeek by switching `config.brain.providers.default`
 * see the same surface for everything else.
 *
 * This subclassing pattern also doubles as the recommended template
 * for any other OpenAI-compatible vendor (Groq, Together, Fireworks,
 * vLLM) — extend `OpenAIProvider`, override the constructor's base
 * URL + default model, optionally override `buildParams` to suppress
 * fields the upstream rejects.
 */

import type OpenAI from 'openai'
import type { AgentGenerateResult } from '../agent_generate_result.ts'
import type { AgentStreamEvent } from '../agent_stream_event.ts'
import { BrainError } from '../brain_error.ts'
import type { DeepSeekProviderConfig } from '../brain_config.ts'
import { parseGenerated, type OutputSchema } from '../output_schema.ts'
import type { ResolveMcpToolsOptions } from '../mcp/resolve_mcp_tools.ts'
import type { RunWithToolsOptions } from '../provider.ts'
import type { Tool } from '../tool.ts'
import type {
  ChatOptions,
  ChatUsage,
  GenerateResult,
  Message,
  SystemPrompt,
} from '../types.ts'
import { OpenAIProvider } from './openai_provider.ts'

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

export interface DeepSeekProviderOptions {
  client?: OpenAI
  /**
   * Internal seam — tests inject a stub MCP client factory so MCP
   * tool resolution doesn't dial the network. Real apps leave it
   * unset; the provider uses the default `MCPClient`.
   */
  mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(
    name: string,
    config: DeepSeekProviderConfig,
    options: DeepSeekProviderOptions = {},
  ) {
    super(
      name,
      {
        driver: 'openai',
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
        defaultModel: config.defaultModel ?? DEFAULT_DEEPSEEK_MODEL,
        ...(config.defaultMaxTokens !== undefined
          ? { defaultMaxTokens: config.defaultMaxTokens }
          : {}),
      },
      options,
    )
  }

  /**
   * Same as the OpenAI build but strips `reasoning_effort` —
   * DeepSeek's `/v1/chat/completions` rejects unknown fields.
   * `deepseek-reasoner` emits its own thinking tokens regardless,
   * so apps don't lose anything by the suppression.
   */
  protected override buildParams(
    messages: readonly Message[],
    options: ChatOptions,
    tools: readonly Tool[],
  ): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const params = super.buildParams(messages, options, tools)
    if ('reasoning_effort' in params) {
      // Use `delete` to keep the typed shape clean — the field is
      // optional on the SDK type.
      delete (params as { reasoning_effort?: unknown }).reasoning_effort
    }
    return params
  }

  /**
   * `generate` on DeepSeek uses `response_format.json_object` mode
   * (the strongest constraint the API offers) and injects the
   * JSON Schema into the system prompt so the model knows what
   * shape to produce. The response is parsed via `parseGenerated`
   * client-side. Apps that supply `schema.parse` get the same
   * runtime validation as on the other providers.
   *
   * Caveat: unlike OpenAI's `strict: true` json_schema mode, the
   * upstream API doesn't enforce the schema. Malformed responses
   * either fail JSON parse (BrainError) or fail `schema.parse`
   * (BrainError). Apps that need stricter guarantees prefer
   * OpenAI / Anthropic / Gemini for `generate`.
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
      usage: toDeepSeekUsage(response.usage),
      raw: response,
    }
  }

  /**
   * Combined tool-loop + structured output isn't supported on
   * DeepSeek in V1 — the API's `response_format.json_object`
   * doesn't carry schema enforcement, and weaving the
   * schema-instruction into every turn's system prompt while a
   * tool loop runs would surprise apps. Apps that need both run
   * `runTools(...)` to gather data, then a separate `generate(...)`
   * call to summarize into the schema.
   */
  override async runWithToolsAndSchema<T>(
    _messages: readonly Message[],
    _tools: readonly Tool[],
    _schema: OutputSchema<T>,
    _options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>> {
    throw new BrainError(
      'DeepSeekProvider.runWithToolsAndSchema: combined tool use + structured output is not supported in V1. DeepSeek does not implement response_format.json_schema. Run `brain.runTools(...)` and `brain.generate(...)` as two separate calls, or switch to OpenAI / Anthropic / Gemini for this combination.',
      { context: { provider: this.name } },
    )
  }

  override async *streamWithToolsAndSchema<T>(
    _messages: readonly Message[],
    _tools: readonly Tool[],
    _schema: OutputSchema<T>,
    _options?: RunWithToolsOptions,
  ): AsyncIterable<AgentStreamEvent<T>> {
    throw new BrainError(
      'DeepSeekProvider.streamWithToolsAndSchema: combined streaming + tool use + structured output is not supported in V1. Use `brain.streamTools(...)` and `brain.generate(...)` separately, or switch to OpenAI / Anthropic / Gemini for this combination.',
      { context: { provider: this.name } },
    )
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

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

function toDeepSeekUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    // DeepSeek reports cache hits on `prompt_cache_hit_tokens` (extension
    // field on their CompletionUsage). Probe it without forcing the
    // typed `cached_tokens` path.
    cacheReadTokens:
      ((u as unknown as { prompt_cache_hit_tokens?: number } | undefined)
        ?.prompt_cache_hit_tokens) ??
      u?.prompt_tokens_details?.cached_tokens ??
      0,
    cacheCreationTokens: 0,
  }
}
