/**
 * `Provider` — the contract every brain backend implements.
 *
 * Each concrete provider (Anthropic, OpenAI later, Gemini later,
 * DeepSeek later) wraps the vendor's SDK and translates the framework
 * shapes (`Message`, `ChatOptions`) into the vendor's native request,
 * then translates the response back into `ChatResult` / `StreamEvent`.
 *
 * Providers are values, not classes — apps use them via the
 * `BrainManager` facade. The interface is exported so apps that need
 * to plug in a custom provider (e.g. a local Ollama) can do so without
 * subclassing.
 */

import type {
  ChatOptions,
  ChatResult,
  Message,
  StreamEvent,
} from './types.ts'

export interface Provider {
  /** Identifier — matches the `config.brain.providers` key. */
  readonly name: string

  /**
   * Generate a single reply. Awaits the full response; for
   * token-by-token rendering use `stream()`.
   */
  chat(messages: readonly Message[], options?: ChatOptions): Promise<ChatResult>

  /**
   * Stream the reply as it's generated. The async iterable yields
   * `text` events for each delta and a final `stop` event with usage
   * + stop-reason. Apps that want the full collected message at the
   * end pass the same `messages` to `chat()` instead; this surface is
   * for UI streaming, not for "make one call and get the message".
   */
  stream(messages: readonly Message[], options?: ChatOptions): AsyncIterable<StreamEvent>

  /**
   * Count input tokens for a given message set + options. Used by
   * apps that need to budget context before sending. Optional — not
   * every provider exposes a cheap token-count endpoint, so the
   * implementation may approximate.
   */
  countTokens?(messages: readonly Message[], options?: ChatOptions): Promise<number>
}
