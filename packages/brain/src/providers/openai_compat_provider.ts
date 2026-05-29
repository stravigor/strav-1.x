/**
 * `OpenAICompatProvider` — abstract intermediate that captures the
 * "OpenAI-compatible local / third-party endpoint" pattern shared by
 * `DeepSeekProvider`, `OllamaProvider`, and anything else (Groq,
 * Together, Fireworks, vLLM, llama.cpp's server, …) that exposes a
 * `/v1/chat/completions` surface that is request-/response-shape-
 * identical to OpenAI's.
 *
 * What it does, factored out of OpenAIProvider:
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
import type { AgentGenerateResult } from '../agent_generate_result.ts'
import type { AgentStreamEvent } from '../agent_stream_event.ts'
import { BrainError } from '../brain_error.ts'
import { parseGenerated, type OutputSchema } from '../output_schema.ts'
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

export abstract class OpenAICompatProvider extends OpenAIProvider {
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
   * Combined tool-loop + structured output isn't supported on
   * OpenAI-compat providers in V1. The API's `json_object` mode
   * doesn't carry schema enforcement, and weaving the
   * schema-instruction into every turn's system prompt during a
   * tool loop would surprise apps. Apps run `runTools(...)` +
   * `generate(...)` as two separate calls, or switch to OpenAI /
   * Anthropic / Gemini for the combined call.
   */
  override async runWithToolsAndSchema<T>(
    _messages: readonly Message[],
    _tools: readonly Tool[],
    _schema: OutputSchema<T>,
    _options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>> {
    throw new BrainError(
      `${this.name}.runWithToolsAndSchema: combined tool use + structured output is not supported on OpenAI-compat providers in V1. Run \`brain.runTools(...)\` and \`brain.generate(...)\` as two separate calls, or switch to OpenAI / Anthropic / Gemini for this combination.`,
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
      `${this.name}.streamWithToolsAndSchema: combined streaming + tool use + structured output is not supported on OpenAI-compat providers in V1. Use \`brain.streamTools(...)\` and \`brain.generate(...)\` separately, or switch to OpenAI / Anthropic / Gemini for this combination.`,
      { context: { provider: this.name } },
    )
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
