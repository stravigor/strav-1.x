/**
 * `OllamaProvider` — `OpenAICompatProvider` pointed at a local
 * Ollama server's OpenAI-compatible `/v1` endpoint.
 *
 * Why this matters: Ollama (and the wider local-LLM ecosystem —
 * LM Studio, llama.cpp's server, vLLM, TGI) lets apps run
 * inference on-device or on-prem. Two real use cases:
 *
 *   - **Privacy.** Data never leaves the machine / the customer's
 *     network — table stakes for regulated workloads.
 *   - **Dev / test.** Build agents without burning API credits or
 *     needing a cloud key at all. Run the test suite against a
 *     local `llama3.2:1b` for free; ship to a hosted provider in
 *     prod.
 *
 * Inherits the OpenAI-compat overrides (strip `reasoning_effort`,
 * `json_object`-mode generate with schema-in-system-prompt,
 * throws on combined tools + schema) from the base. Only adds:
 *
 *   - Constructor with Ollama defaults — base URL
 *     `http://localhost:11434/v1`, placeholder API key `'ollama'`
 *     (the SDK demands a non-empty string; Ollama ignores it).
 *
 * `defaultModel` is required because Ollama models are
 * user-installed via `ollama pull <model>` — no universal default
 * exists. Tool calling depends on the underlying model; pick a
 * function-calling-tuned model (`llama3.2`, `qwen2.5`, `mistral`)
 * for `runWithTools` to behave.
 *
 * The same provider works against any OpenAI-compatible local
 * server by overriding `baseUrl` — LM Studio (`:1234/v1`),
 * llama.cpp's server (`:8080/v1`), vLLM, TGI, remote Ollama on
 * another host. The driver name is `ollama` for ergonomic reasons;
 * the implementation is "any OpenAI-compatible local server."
 *
 * Local inference has no upstream prompt cache, so the default
 * `mapUsage` (cache fields → 0) is correct without override.
 * `countTokens` not implemented (Ollama doesn't expose a count
 * endpoint).
 */

import type OpenAI from 'openai'
import type { OllamaProviderConfig } from '../brain_config.ts'
import type { ResolveMcpToolsOptions } from '../mcp/resolve_mcp_tools.ts'
import { OpenAICompatProvider } from './openai_compat_provider.ts'

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

export class OllamaProvider extends OpenAICompatProvider {
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
}
