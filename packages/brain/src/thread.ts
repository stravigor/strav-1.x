/**
 * `Thread` — multi-turn conversation that retains its message history
 * across calls. Built on top of `BrainManager.chat` (no provider
 * coupling); apps that want a stateless one-shot use
 * `BrainManager.chat` directly.
 *
 * State model: the thread owns an append-only `messages` array. Each
 * `send(text)` appends a user turn, calls `brain.chat`, appends the
 * assistant reply, and returns the assistant's text. The full message
 * history is serializable via `toJSON()` so apps can persist a thread
 * across requests (e.g. one row per conversation in Postgres).
 *
 * What's NOT here in V1:
 *   - Auto-compaction. Long threads accumulate without bound; apps
 *     that need bounded context handle this themselves (prune
 *     `thread.messages` in place, or use the underlying provider's
 *     server-side compaction feature once that ships in V2).
 *   - Streaming `send`. The thread's `send()` is awaited-fully; for
 *     token-by-token streaming in a conversation, call
 *     `brain.stream(thread.messages.concat(newUser))` directly.
 */

import type { BrainManager } from './brain_manager.ts'
import type { ChatOptions, Message, SystemPrompt } from './types.ts'

export interface ThreadOptions {
  /** System prompt — applied to every `send()` call. Supports cache flags. */
  system?: SystemPrompt
  /** Per-thread `ChatOptions` defaults — merged with per-call overrides on `send()`. */
  options?: ChatOptions
}

/** Serializable snapshot. What `toJSON()` produces / `fromJSON()` accepts. */
export interface ThreadState {
  messages: Message[]
  system?: SystemPrompt
  options?: ChatOptions
}

export class Thread {
  /** Append-only conversation history. Read-only — mutate via `send()` (or pass through `toJSON`). */
  readonly messages: Message[] = []
  readonly system?: SystemPrompt
  readonly options?: ChatOptions
  private readonly brain: BrainManager

  constructor(brain: BrainManager, opts: ThreadOptions = {}) {
    this.brain = brain
    if (opts.system !== undefined) this.system = opts.system
    if (opts.options !== undefined) this.options = opts.options
  }

  /**
   * Append a user turn, call the model, append the assistant reply,
   * and return the reply text. Per-call options override the
   * thread's defaults; `system` always comes from the thread.
   */
  async send(text: string, options: ChatOptions = {}): Promise<string> {
    this.messages.push({ role: 'user', content: text })
    const merged: ChatOptions = {
      ...(this.options ?? {}),
      ...options,
      // System is owned by the thread; per-call `system` is ignored
      // intentionally so a caller can't drift the conversation
      // mid-thread by changing the system prompt every turn.
      ...(this.system !== undefined ? { system: this.system } : {}),
    }
    const result = await this.brain.chat(this.messages, merged)
    this.messages.push({ role: 'assistant', content: result.text })
    return result.text
  }

  /** Number of turns. Each `send()` adds 2 (user + assistant). */
  get length(): number {
    return this.messages.length
  }

  /** Serialize to a plain object — pass to `Thread.fromJSON` to restore. */
  toJSON(): ThreadState {
    const state: ThreadState = { messages: [...this.messages] }
    if (this.system !== undefined) state.system = this.system
    if (this.options !== undefined) state.options = this.options
    return state
  }

  /**
   * Restore a thread from a serialized snapshot. The `BrainManager`
   * is passed in fresh — only the conversation state lives on disk;
   * the manager is rebuilt at app boot.
   */
  static fromJSON(brain: BrainManager, state: ThreadState): Thread {
    const options: ThreadOptions = {}
    if (state.system !== undefined) options.system = state.system
    if (state.options !== undefined) options.options = state.options
    const thread = new Thread(brain, options)
    for (const m of state.messages) thread.messages.push(m)
    return thread
  }
}
