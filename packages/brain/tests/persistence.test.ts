/**
 * `@strav/brain/persistence` — schema + repository + BrainStore
 * contract tests. Uses a SpyDb stub for the SQL shape assertions
 * (no Postgres needed) and a minimal in-memory `BrainStore` test
 * double to verify the contract surface is wired correctly.
 */

import { describe, expect, test } from 'bun:test'
import { Archetype } from '@strav/database'
import type { DatabaseExecutor, PostgresDatabase } from '@strav/database'
import { EventBus } from '@strav/kernel'
import {
  BrainMessage,
  BrainMessageRepository,
  BrainSuspendedRun,
  BrainSuspendedRunRepository,
  BrainThread,
  BrainThreadRepository,
  brainMessageSchema,
  brainSuspendedRunSchema,
  brainThreadSchema,
  DatabaseBrainStore,
} from '../src/persistence/index.ts'
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
} from '../src/persistence/index.ts'
import type { SuspendedState } from '../src/suspended_run.ts'
import type { ContentBlock, ToolUseBlock } from '../src/types.ts'

// ─── Schemas ─────────────────────────────────────────────────────────────

describe('persistence schemas', () => {
  test('brain_thread is Entity + tenanted', () => {
    expect(brainThreadSchema.name).toBe('brain_thread')
    expect(brainThreadSchema.archetype).toBe(Archetype.Entity)
    expect(brainThreadSchema.tenancy.tenanted).toBe(true)
  })

  test('brain_message is Event + tenanted + has thread_id FK with cascade', () => {
    expect(brainMessageSchema.name).toBe('brain_message')
    expect(brainMessageSchema.archetype).toBe(Archetype.Event)
    expect(brainMessageSchema.tenancy.tenanted).toBe(true)
    const fk = brainMessageSchema.fields.find((f) => f.name === 'thread_id')
    expect(fk?.kind).toBe('reference')
    expect((fk as { references?: string }).references).toBe('brain_thread')
    expect((fk as { onDelete?: string }).onDelete).toBe('cascade')
  })

  test('brain_message defines role enum with user/assistant', () => {
    const role = brainMessageSchema.fields.find((f) => f.name === 'role')
    expect(role?.kind).toBe('enum')
    expect((role as { values?: readonly string[] }).values).toEqual(['user', 'assistant'])
  })

  test('brain_suspended_run.thread_id is nullable + set-null on delete', () => {
    const fk = brainSuspendedRunSchema.fields.find((f) => f.name === 'thread_id')
    expect(fk?.kind).toBe('reference')
    expect(fk?.nullable).toBe(true)
    expect((fk as { onDelete?: string }).onDelete).toBe('set null')
  })

  test('brain_suspended_run.status defaults to pending', () => {
    const status = brainSuspendedRunSchema.fields.find((f) => f.name === 'status')
    expect(status?.kind).toBe('enum')
    expect(status?.default).toBe('pending')
  })
})

// ─── SpyDb ───────────────────────────────────────────────────────────────

class SpyDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = []
  scriptedRows: Array<Record<string, unknown>> = []
  scriptedExecute = 0

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params })
    const next = this.scriptedRows.shift()
    return next ? ([next] as T[]) : ([] as T[])
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.queries.push({ sql, params })
    return (this.scriptedRows.shift() as T | null) ?? null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.queries.push({ sql, params })
    return this.scriptedExecute
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('SpyDb.raw not implemented')
  }
}

const asPg = (db: SpyDb) => db as unknown as PostgresDatabase

// ─── BrainMessageRepository.appendTurn — SQL shape ──────────────────────

describe('BrainMessageRepository.appendTurn', () => {
  test('emits INSERT with next turn_index computed inline', async () => {
    const db = new SpyDb()
    db.scriptedRows = [{
      id: 'msg-1',
      tenant_id: 't',
      thread_id: 'th-1',
      turn_index: 0,
      role: 'user',
      content: JSON.stringify('hello'),  // jsonb columns come as text from the driver
      model: null,
      usage: null,
      stop_reason: null,
      response_id: null,
      created_at: new Date(),
    }]
    const repo = new BrainMessageRepository({ db: asPg(db), events: new EventBus() })
    await repo.appendTurn({
      threadId: 'th-1',
      role: 'user',
      content: 'hello',
    })
    const insert = db.queries.find((q) => q.sql.includes('INSERT INTO'))
    expect(insert).toBeDefined()
    expect(insert?.sql).toContain('"brain_message"')
    expect(insert?.sql).toContain('COALESCE')
    expect(insert?.sql).toContain('"turn_index"')
    // params: [id, threadId, role, content, model, usage, stopReason, responseId]
    expect(insert?.params[1]).toBe('th-1')
    expect(insert?.params[2]).toBe('user')
    expect(insert?.params[3]).toBe(JSON.stringify('hello'))
    expect(insert?.params[4]).toBeNull()
  })

  test('persists structured ContentBlock[] (tool_use + compaction) as jsonb', async () => {
    const db = new SpyDb()
    const content: ContentBlock[] = [
      { type: 'compaction', content: 'summary', encryptedContent: 'blob' },
      { type: 'text', text: 'hi' },
    ]
    db.scriptedRows = [{
      id: 'msg-2',
      tenant_id: 't',
      thread_id: 'th-2',
      turn_index: 5,
      role: 'assistant',
      content: JSON.stringify(content),
      model: 'claude-opus-4-7',
      usage: JSON.stringify({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      stop_reason: 'end_turn',
      response_id: null,
      created_at: new Date(),
    }]
    const repo = new BrainMessageRepository({ db: asPg(db), events: new EventBus() })
    const out = await repo.appendTurn({
      threadId: 'th-2',
      role: 'assistant',
      content,
      model: 'claude-opus-4-7',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    })
    const insert = db.queries.find((q) => q.sql.includes('INSERT INTO'))
    expect(insert?.params[3]).toBe(JSON.stringify(content))
    expect(insert?.params[4]).toBe('claude-opus-4-7')
    expect(insert?.params[5]).toBe(
      JSON.stringify({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    )
    expect(out.content).toEqual(content)
  })
})

describe('BrainMessageRepository.loadForThread', () => {
  test('SELECTs by thread_id ORDER BY turn_index ASC', async () => {
    const db = new SpyDb()
    const repo = new BrainMessageRepository({ db: asPg(db), events: new EventBus() })
    await repo.loadForThread('th-1')
    const select = db.queries.find((q) => q.sql.startsWith('SELECT'))
    expect(select?.sql).toContain('"brain_message"')
    expect(select?.sql).toContain('"thread_id" = $1')
    expect(select?.sql).toContain('ORDER BY "turn_index" ASC')
    expect(select?.params).toEqual(['th-1'])
  })
})

// ─── BrainThreadRepository.updateResponseId ─────────────────────────────

describe('BrainThreadRepository.updateResponseId', () => {
  test('UPDATEs last_response_id + bumps updated_at via standard update path', async () => {
    const db = new SpyDb()
    db.scriptedRows = [{
      id: 'th-1',
      tenant_id: 't',
      user_id: null,
      title: null,
      system: null,
      options: null,
      last_response_id: 'resp_new',
      created_at: new Date(),
      updated_at: new Date(),
    }]
    const repo = new BrainThreadRepository({ db: asPg(db), events: new EventBus() })
    const thread = Object.assign(new BrainThread(), {
      id: 'th-1',
      tenant_id: 't',
      user_id: null,
      title: null,
      system: null,
      options: null,
      last_response_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    await repo.updateResponseId(thread, 'resp_new')
    const update = db.queries.find((q) => q.sql.startsWith('UPDATE'))
    expect(update?.sql).toContain('"brain_thread"')
    expect(update?.sql).toContain('"last_response_id" = $1')
    expect(update?.sql).toContain('"updated_at" = now()')
  })
})

// ─── BrainSuspendedRunRepository.listPending ────────────────────────────

describe('BrainSuspendedRunRepository.listPending', () => {
  test('SELECTs where status=pending, with optional user_id and thread_id filters', async () => {
    const db = new SpyDb()
    const repo = new BrainSuspendedRunRepository({ db: asPg(db), events: new EventBus() })
    await repo.listPending({ userId: 'u1', threadId: 'th-1', limit: 10 })
    const select = db.queries.find((q) => q.sql.startsWith('SELECT'))
    expect(select?.sql).toContain('"brain_suspended_run"')
    expect(select?.sql).toContain('"status" = $1')
    expect(select?.sql).toContain('"user_id" = $2')
    expect(select?.sql).toContain('"thread_id" = $3')
    expect(select?.sql).toContain('ORDER BY "created_at" DESC')
    expect(select?.sql).toContain('LIMIT 10')
    expect(select?.params).toEqual(['pending', 'u1', 'th-1'])
  })
})

// ─── BrainStore contract — in-memory implementation ──────────────────────

class InMemoryBrainStore implements BrainStore {
  private threads = new Map<string, LoadedThread>()
  private suspended = new Map<string, LoadedSuspendedRun>()
  private counter = 0

  private nextId(prefix: string) {
    return `${prefix}_${++this.counter}`
  }

  async createThread(input: CreateThreadInput) {
    const id = this.nextId('th')
    const now = new Date()
    const state: LoadedThread['state'] = { messages: [] }
    if (input.system !== undefined) state.system = input.system
    if (input.options !== undefined) state.options = input.options
    this.threads.set(id, {
      id,
      state,
      metadata: {
        userId: input.userId ?? null,
        title: input.title ?? null,
        createdAt: now,
        updatedAt: now,
      },
    })
    return { id }
  }

  async loadThread(id: string) {
    return this.threads.get(id) ?? null
  }

  async appendTurn(threadId: string, turn: TurnInput) {
    const t = this.threads.get(threadId)
    if (!t) return
    t.state.messages.push({ role: turn.role, content: turn.content })
    if (turn.responseId !== undefined) t.state.lastResponseId = turn.responseId
    t.metadata.updatedAt = new Date()
  }

  async updateThreadResponseId(threadId: string, responseId: string) {
    const t = this.threads.get(threadId)
    if (!t) return
    t.state.lastResponseId = responseId
    t.metadata.updatedAt = new Date()
  }

  async listThreads(filter: ThreadFilter): Promise<ThreadSummary[]> {
    return [...this.threads.values()]
      .filter((t) => filter.userId === undefined || t.metadata.userId === filter.userId)
      .map((t) => ({
        id: t.id,
        userId: t.metadata.userId,
        title: t.metadata.title,
        lastResponseId: t.state.lastResponseId ?? null,
        createdAt: t.metadata.createdAt,
        updatedAt: t.metadata.updatedAt,
      }))
  }

  async deleteThread(id: string) {
    this.threads.delete(id)
  }

  async saveSuspendedRun(input: SaveSuspendedRunInput) {
    const id = this.nextId('run')
    const now = new Date()
    this.suspended.set(id, {
      id,
      threadId: input.threadId ?? null,
      userId: input.userId ?? null,
      pendingToolCalls: input.pendingToolCalls,
      state: input.state,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    return { id }
  }

  async loadSuspendedRun(id: string) {
    return this.suspended.get(id) ?? null
  }

  async markSuspendedRunStatus(id: string, status: 'resumed' | 'cancelled') {
    const r = this.suspended.get(id)
    if (!r) return
    r.status = status
    r.updatedAt = new Date()
  }

  async listPendingSuspendedRuns(filter: SuspendedFilter): Promise<SuspendedSummary[]> {
    return [...this.suspended.values()]
      .filter((r) => r.status === 'pending')
      .filter((r) => filter.userId === undefined || r.userId === filter.userId)
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        userId: r.userId,
        status: r.status,
        createdAt: r.createdAt,
      }))
  }
}

describe('BrainStore contract — round-trip through in-memory impl', () => {
  test('createThread → appendTurn → loadThread reproduces ThreadState', async () => {
    const store = new InMemoryBrainStore()
    const { id } = await store.createThread({
      userId: 'u1',
      title: 'demo',
      system: 'be concise',
    })
    await store.appendTurn(id, { role: 'user', content: 'hello' })
    await store.appendTurn(id, {
      role: 'assistant',
      content: 'hi there',
      model: 'claude-opus-4-7',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    })
    const loaded = await store.loadThread(id)
    expect(loaded).toBeDefined()
    expect(loaded?.state.system).toBe('be concise')
    expect(loaded?.state.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
    expect(loaded?.metadata.title).toBe('demo')
    expect(loaded?.metadata.userId).toBe('u1')
  })

  test('appendTurn with responseId propagates onto lastResponseId', async () => {
    const store = new InMemoryBrainStore()
    const { id } = await store.createThread({})
    await store.appendTurn(id, { role: 'user', content: 'hi' })
    await store.appendTurn(id, {
      role: 'assistant',
      content: 'reply',
      responseId: 'resp_abc',
    })
    const loaded = await store.loadThread(id)
    expect(loaded?.state.lastResponseId).toBe('resp_abc')
  })

  test('CompactionBlock survives round-trip with encryptedContent preserved', async () => {
    const store = new InMemoryBrainStore()
    const { id } = await store.createThread({})
    const content: ContentBlock[] = [
      { type: 'compaction', content: 'summary', encryptedContent: 'opaque-blob' },
      { type: 'text', text: 'and the answer' },
    ]
    await store.appendTurn(id, { role: 'assistant', content })
    const loaded = await store.loadThread(id)
    const msg = loaded?.state.messages[0]
    expect(msg?.content).toEqual(content)
    const compaction = (msg?.content as ContentBlock[])[0] as {
      content: string | null
      encryptedContent: string | null
    }
    expect(compaction.encryptedContent).toBe('opaque-blob')
  })

  test('saveSuspendedRun → loadSuspendedRun → markResumed round-trip', async () => {
    const store = new InMemoryBrainStore()
    const pending: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu_1', name: 'drop_db', input: { table: 'users' } },
    ]
    const state: SuspendedState = {
      messages: [{ role: 'user', content: 'do it' }],
      iterations: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }
    const { id } = await store.saveSuspendedRun({
      userId: 'u1',
      pendingToolCalls: pending,
      state,
    })
    const loaded = await store.loadSuspendedRun(id)
    expect(loaded?.pendingToolCalls).toEqual(pending)
    expect(loaded?.state).toEqual(state)
    expect(loaded?.status).toBe('pending')
    await store.markSuspendedRunStatus(id, 'resumed')
    const after = await store.loadSuspendedRun(id)
    expect(after?.status).toBe('resumed')
  })

  test('listPendingSuspendedRuns excludes resumed/cancelled', async () => {
    const store = new InMemoryBrainStore()
    const state: SuspendedState = {
      messages: [],
      iterations: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }
    const a = await store.saveSuspendedRun({ pendingToolCalls: [], state })
    const b = await store.saveSuspendedRun({ pendingToolCalls: [], state })
    await store.markSuspendedRunStatus(a.id, 'resumed')
    const pending = await store.listPendingSuspendedRuns({})
    expect(pending.map((p) => p.id)).toEqual([b.id])
  })
})

// ─── DatabaseBrainStore — wiring through repos ──────────────────────────

describe('DatabaseBrainStore', () => {
  test('appendTurn with responseId also bumps the thread.last_response_id', async () => {
    const db = new SpyDb()
    // Scripted rows for: appendTurn INSERT, threads.find SELECT, threads.update UPDATE.
    const now = new Date()
    db.scriptedRows = [
      {
        id: 'msg-1', tenant_id: 't', thread_id: 'th-1', turn_index: 0,
        role: 'assistant', content: JSON.stringify('hi'), model: 'gpt-5',
        usage: null, stop_reason: 'end_turn', response_id: 'resp_xyz',
        created_at: now,
      },
      {
        id: 'th-1', tenant_id: 't', user_id: null, title: null,
        system: null, options: null, last_response_id: null,
        created_at: now, updated_at: now,
      },
      {
        id: 'th-1', tenant_id: 't', user_id: null, title: null,
        system: null, options: null, last_response_id: 'resp_xyz',
        created_at: now, updated_at: now,
      },
    ]
    const threads = new BrainThreadRepository({ db: asPg(db), events: new EventBus() })
    const messages = new BrainMessageRepository({ db: asPg(db), events: new EventBus() })
    const suspended = new BrainSuspendedRunRepository({ db: asPg(db), events: new EventBus() })
    const store = new DatabaseBrainStore(threads, messages, suspended)
    await store.appendTurn('th-1', {
      role: 'assistant',
      content: 'hi',
      responseId: 'resp_xyz',
    })
    const update = db.queries.find((q) => q.sql.startsWith('UPDATE'))
    expect(update?.sql).toContain('"brain_thread"')
    expect(update?.sql).toContain('"last_response_id" = $1')
  })
})
