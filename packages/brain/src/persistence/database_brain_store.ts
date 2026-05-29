/**
 * `DatabaseBrainStore` — Postgres-backed implementation of
 * `BrainStore`. Composes the three shipped repositories
 * (`BrainThreadRepository`, `BrainMessageRepository`,
 * `BrainSuspendedRunRepository`) into a single store surface.
 *
 * All multitenancy is transparent here — the repositories scope
 * via RLS when the call is wrapped in `tenants.withTenant(...)`.
 * Apps wire this once via `app.resolve(DatabaseBrainStore)` and
 * inject it where conversations need to be persisted.
 *
 * Apps that need a different backend implement `BrainStore`
 * directly against Redis / Mongo / in-memory / etc. — the
 * schemas + repositories are framework conveniences, not
 * obligations.
 */

// biome-ignore lint/style/useImportType: classes are value imports for @inject() param-type metadata.
import { inject } from '@strav/kernel'
// biome-ignore lint/style/useImportType: repository classes value imports for @inject().
import { BrainMessageRepository } from './brain_message_repository.ts'
// biome-ignore lint/style/useImportType: repository classes value imports for @inject().
import { BrainSuspendedRunRepository } from './brain_suspended_run_repository.ts'
// biome-ignore lint/style/useImportType: repository classes value imports for @inject().
import { BrainThreadRepository } from './brain_thread_repository.ts'
import type {
  BrainStore,
  CreateThreadInput,
  LoadedSuspendedRun,
  LoadedThread,
  SaveSuspendedRunInput,
  SuspendedFilter,
  SuspendedSummary,
  ThreadFilter,
  ThreadSummary,
  TurnInput,
} from './brain_store.ts'

@inject()
export class DatabaseBrainStore implements BrainStore {
  constructor(
    private readonly threads: BrainThreadRepository,
    private readonly messages: BrainMessageRepository,
    private readonly suspendedRuns: BrainSuspendedRunRepository,
  ) {}

  // ── Threads ────────────────────────────────────────────────────────────

  async createThread(input: CreateThreadInput): Promise<{ id: string }> {
    const created = await this.threads.create({
      user_id: input.userId ?? null,
      title: input.title ?? null,
      system: input.system ?? null,
      options: input.options ?? null,
      last_response_id: null,
    })
    return { id: created.id }
  }

  async loadThread(id: string): Promise<LoadedThread | null> {
    const thread = await this.threads.find(id)
    if (!thread) return null
    const rows = await this.messages.loadForThread(id)
    const result: LoadedThread = {
      id: thread.id,
      state: {
        messages: rows.map((m) => ({ role: m.role, content: m.content })),
      },
      metadata: {
        userId: thread.user_id,
        title: thread.title,
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
      },
    }
    if (thread.system !== null) result.state.system = thread.system
    if (thread.options !== null) result.state.options = thread.options
    if (thread.last_response_id !== null) {
      result.state.lastResponseId = thread.last_response_id
    }
    return result
  }

  async appendTurn(threadId: string, turn: TurnInput): Promise<void> {
    await this.messages.appendTurn({
      threadId,
      role: turn.role,
      content: turn.content,
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
      ...(turn.stopReason !== undefined ? { stopReason: turn.stopReason } : {}),
      ...(turn.responseId !== undefined ? { responseId: turn.responseId } : {}),
    })
    // When the model surfaced a new response id, also bump the
    // thread-level pointer so subsequent loads + sends thread it via
    // `previousResponseId` automatically.
    if (turn.responseId !== undefined) {
      const thread = await this.threads.find(threadId)
      if (thread) {
        await this.threads.updateResponseId(thread, turn.responseId)
      }
    }
  }

  async updateThreadResponseId(threadId: string, responseId: string): Promise<void> {
    const thread = await this.threads.find(threadId)
    if (!thread) return
    await this.threads.updateResponseId(thread, responseId)
  }

  async listThreads(filter: ThreadFilter): Promise<ThreadSummary[]> {
    const list = await this.threads.listForUser(filter.userId ?? null, {
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
    })
    return list.map((t) => ({
      id: t.id,
      userId: t.user_id,
      title: t.title,
      lastResponseId: t.last_response_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }))
  }

  async deleteThread(id: string): Promise<void> {
    const thread = await this.threads.find(id)
    if (!thread) return
    await this.threads.delete(thread)
  }

  // ── Suspended runs ─────────────────────────────────────────────────────

  async saveSuspendedRun(input: SaveSuspendedRunInput): Promise<{ id: string }> {
    const created = await this.suspendedRuns.create({
      thread_id: input.threadId ?? null,
      user_id: input.userId ?? null,
      pending_tool_calls: input.pendingToolCalls,
      state: input.state,
      status: 'pending',
    })
    return { id: created.id }
  }

  async loadSuspendedRun(id: string): Promise<LoadedSuspendedRun | null> {
    const row = await this.suspendedRuns.find(id)
    if (!row) return null
    return {
      id: row.id,
      threadId: row.thread_id,
      userId: row.user_id,
      pendingToolCalls: row.pending_tool_calls,
      state: row.state,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async markSuspendedRunStatus(
    id: string,
    status: 'resumed' | 'cancelled',
  ): Promise<void> {
    const row = await this.suspendedRuns.find(id)
    if (!row) return
    if (status === 'resumed') {
      await this.suspendedRuns.markResumed(row)
    } else {
      await this.suspendedRuns.markCancelled(row)
    }
  }

  async listPendingSuspendedRuns(
    filter: SuspendedFilter,
  ): Promise<SuspendedSummary[]> {
    const rows = await this.suspendedRuns.listPending({
      ...(filter.userId !== undefined ? { userId: filter.userId } : {}),
      ...(filter.threadId !== undefined ? { threadId: filter.threadId } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
    })
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      userId: r.user_id,
      status: r.status,
      createdAt: r.created_at,
    }))
  }
}
