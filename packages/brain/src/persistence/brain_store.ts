/**
 * `BrainStore` — the storage abstraction for `@strav/brain`
 * conversation state.
 *
 * Apps call into `BrainStore` to persist threads, append turns,
 * and track human-in-the-loop suspended runs. The default
 * implementation (`DatabaseBrainStore`) is backed by the three
 * shipped schemas + repositories against Postgres. Apps that want
 * a different backend (Redis / Mongo / in-memory for tests)
 * implement this interface directly — the schemas + repositories
 * stay optional.
 *
 * Multitenancy: `BrainStore` itself is tenant-agnostic. Tenant
 * scoping is the caller's responsibility — wrap calls in
 * `tenants.withTenant(...)` and the backend (RLS, app-level
 * filters, separate keyspaces) does its thing.
 *
 * Integration with `Thread`: this abstraction is intentionally
 * parallel to `Thread`. Apps don't call `Thread.send()` and
 * `store.appendTurn()` simultaneously by default — pick the side
 * that fits the request lifecycle:
 *
 *   - **Stateless request handlers** (one request = one turn):
 *     load the thread state via `store.loadThread(id)`, build a
 *     fresh `Thread` from it, call `thread.send(text)`, persist
 *     the user + assistant turns via `store.appendTurn(...)`,
 *     return the response. The `Thread` instance dies with the
 *     request.
 *
 *   - **Long-lived workers** (e.g., chat-streaming connections):
 *     keep the `Thread` in memory for the connection's lifetime
 *     and call `store.appendTurn(...)` after each `send()`.
 */

import type { SuspendedState } from '../suspended_run.ts'
import type {
  ChatOptions,
  ChatUsage,
  ContentBlock,
  SystemPrompt,
  ToolUseBlock,
} from '../types.ts'

// ─── Thread inputs / outputs ─────────────────────────────────────────────

export interface CreateThreadInput {
  /** App-defined owner. Optional — anonymous / shared threads are fine. */
  userId?: string
  /** Human label. Apps set it from the first user turn or via a "rename" UI. */
  title?: string
  /** Thread-owned system prompt — applied on every `send()`. */
  system?: SystemPrompt
  /** Per-thread defaults merged with per-call options on every `send()`. */
  options?: ChatOptions
}

/**
 * What `loadThread(id)` returns. `state` is the shape `Thread.fromJSON`
 * accepts directly; metadata fields surface alongside for app code
 * that wants the row's bookkeeping (timestamps, title, user id) too.
 */
export interface LoadedThread {
  id: string
  state: {
    messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>
    system?: SystemPrompt
    options?: ChatOptions
    lastResponseId?: string
  }
  metadata: {
    userId: string | null
    title: string | null
    createdAt: Date
    updatedAt: Date
  }
}

export interface TurnInput {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  /** Model used for assistant turns. Omitted for user turns. */
  model?: string
  /** Token usage from the model call. Assistant turns only. */
  usage?: ChatUsage
  /** Provider terminal reason — `end_turn`, `max_iterations`, etc. */
  stopReason?: string
  /**
   * Provider response id when surfaced — OpenAI Responses API today.
   * Also bumps `last_response_id` on the parent thread so subsequent
   * sends auto-thread it via `previousResponseId`.
   */
  responseId?: string
}

export interface ThreadFilter {
  userId?: string
  limit?: number
  offset?: number
}

export interface ThreadSummary {
  id: string
  userId: string | null
  title: string | null
  lastResponseId: string | null
  createdAt: Date
  updatedAt: Date
}

// ─── Suspended-run inputs / outputs ──────────────────────────────────────

export interface SaveSuspendedRunInput {
  /** Optional link to the thread the run came from. */
  threadId?: string
  /** App-defined approver. */
  userId?: string
  pendingToolCalls: ToolUseBlock[]
  state: SuspendedState
}

export interface LoadedSuspendedRun {
  id: string
  threadId: string | null
  userId: string | null
  pendingToolCalls: ToolUseBlock[]
  state: SuspendedState
  status: 'pending' | 'resumed' | 'cancelled'
  createdAt: Date
  updatedAt: Date
}

export interface SuspendedFilter {
  userId?: string
  threadId?: string
  limit?: number
  offset?: number
}

export interface SuspendedSummary {
  id: string
  threadId: string | null
  userId: string | null
  status: 'pending' | 'resumed' | 'cancelled'
  createdAt: Date
}

// ─── The interface ───────────────────────────────────────────────────────

export interface BrainStore {
  // ── Threads ───────────────────────────────────────────────────────────
  createThread(input: CreateThreadInput): Promise<{ id: string }>
  loadThread(id: string): Promise<LoadedThread | null>
  appendTurn(threadId: string, turn: TurnInput): Promise<void>
  updateThreadResponseId(threadId: string, responseId: string): Promise<void>
  listThreads(filter: ThreadFilter): Promise<ThreadSummary[]>
  deleteThread(id: string): Promise<void>

  // ── Suspended runs ────────────────────────────────────────────────────
  saveSuspendedRun(run: SaveSuspendedRunInput): Promise<{ id: string }>
  loadSuspendedRun(id: string): Promise<LoadedSuspendedRun | null>
  markSuspendedRunStatus(
    id: string,
    status: 'resumed' | 'cancelled',
  ): Promise<void>
  listPendingSuspendedRuns(filter: SuspendedFilter): Promise<SuspendedSummary[]>
}
