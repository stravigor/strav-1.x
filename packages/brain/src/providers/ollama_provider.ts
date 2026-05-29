/**
 * `OllamaProvider` — implementation of `Provider` backed by the
 * `openai` SDK pointed at a local Ollama server's
 * OpenAI-compatible `/v1` endpoint.
 *
 * Why this matters: Ollama (and the wider local-LLM ecosystem —
 * LM Studio, llama.cpp's server, vLLM, TGI) lets apps run inference
 * on-device or on-prem. Two real use cases:
 *
 *   - **Privacy.** Data never leaves the machine / the customer's
 *     network — table stakes for regulated workloads.
 *   - **Dev / test.** Build agents without burning API credits or
 *     needing a cloud key at all. Run the test suite against a
 *     local `llama3.2:1b` for free; ship to a hosted provider in
 *     prod.
 *
 * The provider extends `OpenAIProvider` because Ollama's
 * OpenAI-compat layer is request/response-shape-identical for the
 * surface the framework uses (chat completions, streaming,
 * function calling, `response_format`). Only three things diverge —
 * the same divergence set as `DeepSeekProvider`:
 *
 *   - **Default base URL + no API key.** `http://localhost:11434/v1`
 *     and `apiKey: 'ollama'` (the SDK demands a non-empty string;
 *     Ollama ignores it). Apps point at a different URL when
 *     running Ollama on another host or behind a proxy.
 *
 *   - **No `reasoning_effort`.** Ollama's OpenAI-compat layer
 *     rejects unknown fields. Models with built-in thinking
 *     (e.g. `qwen3-thinking`, `deepseek-r1` distills) emit
 *     thinking tokens regardless of the absent control.
 *
 *   - **No `response_format.json_schema`.** Recent Ollama supports
 *     `json_schema` for some models but behavior varies. The safe
 *     default is `response_format.json_object` + schema-in-system
 *     prompt + client-side `parseGenerated` — works on every
 *     tool-capable Ollama model. Combined tools+schema throws,
 *     same as DeepSeek.
 *
 * Tool calling depends on the model. Llama 3.1+, Llama 3.2,
 * Qwen 2.5, Mistral, and similar function-calling-tuned models
 * work. Older / smaller models without function-calling training
 * will either ignore tool definitions or return malformed
 * `tool_calls`. Apps that need tools pick a tool-capable model.
 *
 * `countTokens` not implemented — Ollama doesn't expose a count
 * endpoint. `BrainManager.countTokens` returns `null` when routed
 * here.
 */

import type OpenAI from 'openai'
import type { AgentGenerateResult } from '../agent_generate_result.ts'
import type { AgentStreamEvent } from '../agent_stream_event.ts'
import { BrainError } from '../brain_error.ts'
import type { OllamaProviderConfig } from '../brain_config.ts'
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

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const DEFAULT_OLLAMA_API_KEY = 'ollama'

export interface OllamaProviderOptions {
  client?: OpenAI
  /**
   * Internal seam — tests inject a stub MCP client factory so MCP
   * tool resolution doesn't dial the network. Real apps leave it
   * unset; the provider uses the default `MCPClient`.
   */
  mcpClientFactory?: ResolveMcpToolsOptions['clientFactory']
}

export class OllamaProvider extends OpenAIProvider {
  constructor(
    name: string,
    config: OllamaProviderConfig,
    options: OllamaProviderOptions = {},
  ) {
    super(
      name,
      {
        driver: 'openai',
        apiKey: config.apiKey ?? DEFAULT_OLLAMA_API_KEY,
        baseUrl: config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        defaultModel: config.defaultModel,
        ...(config.defaultMaxTokens !== undefined
          ? { defaultMaxTokens: config.defaultMaxTokens }
          : {}),
      },
      options,
    )
  }

  /**
   * Same as the OpenAI build but strips `reasoning_effort` —
   * Ollama's OpenAI-compat layer rejects unknown fields. Models
   * with built-in thinking emit it regardless.
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
   * `generate` uses `response_format.json_object` mode and injects
   * the JSON Schema into the system prompt as a "respond with JSON
   * matching this schema" instruction. The response is parsed via
   * `parseGenerated` client-side — runtime validation when
   * `schema.parse` is set.
   *
   * Caveat: unlike OpenAI's `strict: true` json_schema mode, the
   * upstream Ollama model isn't constrained to the schema by the
   * runtime. Smaller models may hallucinate fields or shapes;
   * `parseGenerated` (and `schema.parse` when set) catches that
   * at the boundary.
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
      usage: toOllamaUsage(response.usage),
      raw: response,
    }
  }

  /**
   * Combined tool-loop + structured output isn't supported on
   * Ollama in V1 for the same reasons as DeepSeek — the API's
   * `json_object` mode doesn't carry schema enforcement, and
   * weaving schema-instructions into every turn's system prompt
   * while a tool loop runs would surprise apps. Run `runTools` +
   * a separate `generate` call instead, or switch to OpenAI /
   * Anthropic / Gemini for the combination.
   */
  override async runWithToolsAndSchema<T>(
    _messages: readonly Message[],
    _tools: readonly Tool[],
    _schema: OutputSchema<T>,
    _options?: RunWithToolsOptions,
  ): Promise<AgentGenerateResult<T>> {
    throw new BrainError(
      'OllamaProvider.runWithToolsAndSchema: combined tool use + structured output is not supported in V1. Run `brain.runTools(...)` and `brain.generate(...)` as two separate calls, or switch to OpenAI / Anthropic / Gemini for this combination.',
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
      'OllamaProvider.streamWithToolsAndSchema: combined streaming + tool use + structured output is not supported in V1. Use `brain.streamTools(...)` and `brain.generate(...)` separately, or switch to OpenAI / Anthropic / Gemini for this combination.',
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

function toOllamaUsage(u: OpenAI.CompletionUsage | undefined): ChatUsage {
  // Ollama is local — no upstream prompt cache. Cache token fields
  // stay zero; apps don't pay for tokens anyway.
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}
