import { describe, expect, test } from 'bun:test'
import { EventBus } from '@strav/kernel'
import {
  Archetype,
  defineSchema,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
} from '../src/index.ts'
import { InMemoryDatabase } from './in_memory_database.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
})

class User extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  created_at!: Date
  updated_at!: Date
}

class UserRepository extends Repository<User> {
  static override readonly schema = userSchema
  static override readonly model: ModelClass = User as unknown as ModelClass
}

/**
 * Subclass of InMemoryDatabase that simulates the user table well enough
 * for create/update/delete round-trips. Identical to the shape used by
 * repository.test.ts — split out here so this file stays self-contained.
 */
class FakeUserDb extends InMemoryDatabase {
  rows = new Map<string, Record<string, unknown>>()

  override async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    if (/SELECT .+ FROM "user".+WHERE "id" = \$1/i.test(sql)) {
      const row = this.rows.get(String(params[0]))
      return (row ? [row] : []) as T[]
    }
    if (/SELECT .+ FROM "user"/i.test(sql)) return [...this.rows.values()] as T[]
    return super.query(sql, params)
  }
  override async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    if (/INSERT INTO "user".+RETURNING \*/i.test(sql)) {
      const row = parseInsertReturning(sql, params)
      this.rows.set(String(row.id), row)
      return row as T
    }
    if (/UPDATE "user".+RETURNING \*/i.test(sql)) {
      const id = String(params[params.length - 1])
      const row = this.rows.get(id)
      if (!row) return null
      const updated = applyUpdate(sql, params, row)
      this.rows.set(id, updated)
      return updated as T
    }
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }
  override async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    if (/DELETE FROM "user" WHERE "id" = \$1/i.test(sql)) {
      const before = this.rows.size
      this.rows.delete(String(params[0]))
      return before - this.rows.size
    }
    return super.execute(sql, params)
  }
}

function parseInsertReturning(sql: string, params: readonly unknown[]): Record<string, unknown> {
  const match = /INSERT INTO "user" \(([^)]+)\)/i.exec(sql)
  if (!match) return {}
  const cols = (match[1] ?? '').split(',').map((c) => c.trim().replace(/"/g, ''))
  const row: Record<string, unknown> = {}
  cols.forEach((c, i) => {
    row[c] = params[i]
  })
  return row
}

function applyUpdate(
  sql: string,
  params: readonly unknown[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const match = /SET (.+?) WHERE/i.exec(sql)
  if (!match) return row
  const sets = (match[1] ?? '').split(',').map((c) => c.trim())
  const next = { ...row }
  let i = 0
  for (const set of sets) {
    const colMatch = /"([^"]+)"\s*=\s*\$(\d+)/.exec(set)
    if (colMatch) {
      next[colMatch[1] ?? ''] = params[i++]
    } else {
      // updated_at = now() — leave to the DB; we don't track it in tests.
    }
  }
  return next
}

function makeRepo(): { repo: UserRepository; events: EventBus; db: FakeUserDb } {
  const db = new FakeUserDb()
  const events = new EventBus()
  const repo = new UserRepository({ db: db as unknown as PostgresDatabase, events })
  return { repo, events, db }
}

// ─────────────────────────────────────────────────────────────────────────────
// create — creating + created
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.create — lifecycle events', () => {
  test('fires user.creating before INSERT and user.created after', async () => {
    const { repo, events, db } = makeRepo()
    const calls: string[] = []
    events.on('user.creating', () => {
      calls.push(`creating (rows=${db.rows.size})`)
    })
    events.on('user.created', () => {
      calls.push(`created (rows=${db.rows.size})`)
    })
    await repo.create({ email: 'a@b.com' } as Partial<User>)
    expect(calls).toEqual(['creating (rows=0)', 'created (rows=1)'])
  })

  test('creating payload exposes resource + attrs', async () => {
    const { repo, events } = makeRepo()
    let captured: { resource?: string; attrs?: unknown } = {}
    events.on('user.creating', (payload: unknown) => {
      captured = payload as typeof captured
    })
    await repo.create({ email: 'x@y.com' } as Partial<User>)
    expect(captured.resource).toBe('user')
    expect(captured.attrs).toEqual({ email: 'x@y.com' })
  })

  test('created payload exposes the persisted model (with auto-minted id)', async () => {
    const { repo, events } = makeRepo()
    let captured: { resource?: string; model?: User } = {}
    events.on('user.created', (payload: unknown) => {
      captured = payload as typeof captured
    })
    const created = await repo.create({ email: 'z@y.com' } as Partial<User>)
    expect(captured.resource).toBe('user')
    expect(captured.model).toBe(created)
    expect(typeof captured.model?.id).toBe('string')
    expect(captured.model?.email).toBe('z@y.com')
  })

  test('a throwing user.creating listener aborts the INSERT', async () => {
    const { repo, events, db } = makeRepo()
    events.on('user.creating', () => {
      throw new Error('veto')
    })
    await expect(repo.create({ email: 'x@y.com' } as Partial<User>)).rejects.toThrow(/veto/)
    expect(db.rows.size).toBe(0)
  })

  test('no events fire when the Repository has no EventBus', async () => {
    const db = new FakeUserDb()
    const repo = new UserRepository({ db: db as unknown as PostgresDatabase })
    // Should succeed without throwing, no events to listen to.
    const created = await repo.create({ email: 'a@b.com' } as Partial<User>)
    expect(created.email).toBe('a@b.com')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// update — updating + updated
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.update — lifecycle events', () => {
  test('fires user.updating before the UPDATE and user.updated after', async () => {
    const { repo, events } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    const calls: string[] = []
    events.on('user.updating', () => {
      calls.push('updating')
    })
    events.on('user.updated', () => {
      calls.push('updated')
    })
    await repo.update(seed, { email: 'b@b.com' } as Partial<User>)
    expect(calls).toEqual(['updating', 'updated'])
  })

  test('updating payload carries model + changes', async () => {
    const { repo, events } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    let captured: { resource?: string; model?: User; changes?: Partial<User> } = {}
    events.on('user.updating', (payload: unknown) => {
      captured = payload as typeof captured
    })
    await repo.update(seed, { email: 'b@b.com' } as Partial<User>)
    expect(captured.resource).toBe('user')
    expect(captured.model).toBe(seed)
    expect(captured.changes).toEqual({ email: 'b@b.com' } as Partial<User>)
  })

  test('updated payload carries the AFTER-state model', async () => {
    const { repo, events } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    let captured: { model?: User } = {}
    events.on('user.updated', (payload: unknown) => {
      captured = payload as typeof captured
    })
    const updated = await repo.update(seed, { email: 'b@b.com' } as Partial<User>)
    expect(captured.model).toBe(updated)
    expect(captured.model?.email).toBe('b@b.com')
  })

  test('a throwing user.updating listener aborts the UPDATE', async () => {
    const { repo, events, db } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    events.on('user.updating', () => {
      throw new Error('veto')
    })
    await expect(repo.update(seed, { email: 'b@b.com' } as Partial<User>)).rejects.toThrow(/veto/)
    // Row is unchanged.
    const row = db.rows.get(seed.id)
    expect(row?.email).toBe('a@b.com')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// delete — deleting + deleted
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository.delete — lifecycle events', () => {
  test('fires user.deleting before and user.deleted after the DELETE', async () => {
    const { repo, events, db } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    const calls: string[] = []
    events.on('user.deleting', () => {
      calls.push(`deleting (rows=${db.rows.size})`)
    })
    events.on('user.deleted', () => {
      calls.push(`deleted (rows=${db.rows.size})`)
    })
    await repo.delete(seed)
    expect(calls).toEqual(['deleting (rows=1)', 'deleted (rows=0)'])
  })

  test('a throwing user.deleting listener aborts the DELETE', async () => {
    const { repo, events, db } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    events.on('user.deleting', () => {
      throw new Error('veto')
    })
    await expect(repo.delete(seed)).rejects.toThrow(/veto/)
    expect(db.rows.size).toBe(1)
  })

  test('deleted payload carries the model that was just removed', async () => {
    const { repo, events } = makeRepo()
    const seed = await repo.create({ email: 'a@b.com' } as Partial<User>)
    let captured: { model?: User } = {}
    events.on('user.deleted', (payload: unknown) => {
      captured = payload as typeof captured
    })
    await repo.delete(seed)
    expect(captured.model).toBe(seed)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting
// ─────────────────────────────────────────────────────────────────────────────

describe('Repository — cross-cutting event behavior', () => {
  test('event names follow `<schema.name>.<verb>` — confirmed across all six events', async () => {
    const { repo, events } = makeRepo()
    const fired: string[] = []
    // Wildcard at the schema level — every lifecycle event for `user`.
    events.on('user.*', (_payload: unknown, name?: string) => {
      if (name) fired.push(name)
    })
    const u = await repo.create({ email: 'a@b.com' } as Partial<User>)
    await repo.update(u, { email: 'b@b.com' } as Partial<User>)
    await repo.delete(u)
    expect(fired).toEqual([
      'user.creating',
      'user.created',
      'user.updating',
      'user.updated',
      'user.deleting',
      'user.deleted',
    ])
  })
})
