import { describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import { TenantManager } from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fake Database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records every transaction the manager opens + every SQL call inside.
 * Implements `Database` structurally — TenantManager talks to it through
 * the `transaction(fn)` entry point.
 */
class FakeDb implements Database {
  readonly executed: Array<{ sql: string; params: readonly unknown[]; inTransaction: boolean }> = []
  transactionsOpened = 0

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.executed.push({ sql, params, inTransaction: false })
    return []
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.executed.push({ sql, params, inTransaction: false })
    return null
  }
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    this.executed.push({ sql, params, inTransaction: false })
    return 0
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    this.transactionsOpened++
    const tx: DatabaseExecutor = {
      query: async (sql, params = []) => {
        this.executed.push({ sql, params, inTransaction: true })
        return []
      },
      queryOne: async (sql, params = []) => {
        this.executed.push({ sql, params, inTransaction: true })
        return null
      },
      execute: async (sql, params = []) => {
        this.executed.push({ sql, params, inTransaction: true })
        return 0
      },
    }
    return fn(tx)
  }
  async close() {}
  raw(): never {
    throw new Error('FakeDb.raw not implemented')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// withTenant
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantManager.withTenant', () => {
  test('opens a transaction and calls set_config with the tenant id', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withTenant('t-1', async (tx) => {
      await tx.execute('SELECT 1')
    })
    expect(db.transactionsOpened).toBe(1)
    expect(db.executed).toHaveLength(2)
    expect(db.executed[0]).toEqual({
      sql: `SELECT set_config('app.tenant_id', $1, true)`,
      params: ['t-1'],
      inTransaction: true,
    })
    expect(db.executed[1]).toEqual({
      sql: 'SELECT 1',
      params: [],
      inTransaction: true,
    })
  })

  test('returns the callback result', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    const result = await tm.withTenant('t-1', async () => 42)
    expect(result).toBe(42)
  })

  test('currentTenantId() returns the active tenant inside the scope', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    expect(tm.currentTenantId()).toBeNull()
    await tm.withTenant('t-7', async () => {
      expect(tm.currentTenantId()).toBe('t-7')
    })
    expect(tm.currentTenantId()).toBeNull()
  })

  test('rejects empty tenant ids', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await expect(tm.withTenant('', async () => undefined)).rejects.toThrow(/non-empty string/)
  })

  test('nested withTenant with the same id passes through (single transaction)', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    const seen: Array<string | null> = []
    await tm.withTenant('t-1', async () => {
      await tm.withTenant('t-1', async () => {
        seen.push(tm.currentTenantId())
      })
    })
    expect(seen).toEqual(['t-1'])
    // UoW detects the ambient scope on the nested call and reuses the
    // outer transaction — no savepoint, no second BEGIN.
    expect(db.transactionsOpened).toBe(1)
  })

  test('nested withTenant with a DIFFERENT id throws', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await expect(
      tm.withTenant('t-1', async () => {
        await tm.withTenant('t-2', async () => undefined)
      }),
    ).rejects.toThrow(/outer "t-1" vs inner "t-2"/)
  })

  test('exceptions in the callback propagate', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await expect(
      tm.withTenant('t-1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)
    expect(tm.currentTenantId()).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// withoutTenant
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantManager.withoutTenant', () => {
  test('opens a transaction without binding app.tenant_id', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withoutTenant(async (tx) => {
      await tx.execute('SELECT 1')
    })
    expect(db.transactionsOpened).toBe(1)
    // Only the caller's SELECT 1 — no set_config.
    expect(db.executed).toHaveLength(1)
    expect(db.executed[0]?.sql).toBe('SELECT 1')
  })

  test('currentTenantId() is null inside the scope', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withTenant('t-3', async () => {
      // Calling withoutTenant from inside a tenant scope clears the
      // current tenant for the inner block.
      await tm.withoutTenant(async () => {
        expect(tm.currentTenantId()).toBeNull()
      })
      // Back to t-3.
      expect(tm.currentTenantId()).toBe('t-3')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// withTenantLock — advisory lock scoped to (tenant, key)
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantManager.withTenantLock', () => {
  test('opens a tenant transaction, sets the tenant, then takes the advisory lock', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withTenantLock('t-1', 'invoice-batch', async (tx) => {
      await tx.execute('SELECT 1')
    })
    expect(db.transactionsOpened).toBe(1)
    expect(db.executed).toHaveLength(3)
    expect(db.executed[0]?.sql).toBe(`SELECT set_config('app.tenant_id', $1, true)`)
    expect(db.executed[0]?.params).toEqual(['t-1'])
    expect(db.executed[1]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      params: ['t-1', 'invoice-batch'],
      inTransaction: true,
    })
    expect(db.executed[2]?.sql).toBe('SELECT 1')
  })

  test('runs inside `currentTenantId()` scope', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    expect(tm.currentTenantId()).toBeNull()
    await tm.withTenantLock('t-2', 'k', async () => {
      expect(tm.currentTenantId()).toBe('t-2')
    })
    expect(tm.currentTenantId()).toBeNull()
  })

  test('returns the callback result', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    const result = await tm.withTenantLock('t-1', 'k', async () => 'ok')
    expect(result).toBe('ok')
  })

  test('rejects an empty lock key', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await expect(tm.withTenantLock('t-1', '', async () => undefined)).rejects.toThrow(
      /non-empty string/,
    )
  })

  test('rejects an empty tenant id (delegated to withTenant)', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await expect(tm.withTenantLock('', 'k', async () => undefined)).rejects.toThrow(
      /non-empty string/,
    )
  })

  test('nested call with the same tenant + a different lock key reuses the outer transaction', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withTenant('t-1', async () => {
      await tm.withTenantLock('t-1', 'inner', async (tx) => {
        await tx.execute('SELECT 1')
      })
    })
    // Single transaction — the inner withTenantLock acquired the lock on
    // the existing tx rather than opening a nested one.
    expect(db.transactionsOpened).toBe(1)
    const lockCall = db.executed.find((c) =>
      c.sql.startsWith('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))'),
    )
    expect(lockCall?.params).toEqual(['t-1', 'inner'])
  })

  test('nested call with a different tenant throws', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withTenant('t-A', async () => {
      await expect(tm.withTenantLock('t-B', 'k', async () => undefined)).rejects.toThrow(
        /different tenant/,
      )
    })
  })

  test('different tenants holding the same lock key are independent', async () => {
    // Smoke test for the (tenant, key) partitioning at the SQL layer: the
    // emitted params include both, so different tenant IDs hash to
    // different (key1, key2) pairs in Postgres.
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withTenantLock('t-1', 'shared', async () => undefined)
    await tm.withTenantLock('t-2', 'shared', async () => undefined)
    const lockCalls = db.executed.filter((c) =>
      c.sql.startsWith('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))'),
    )
    expect(lockCalls).toHaveLength(2)
    expect(lockCalls[0]?.params).toEqual(['t-1', 'shared'])
    expect(lockCalls[1]?.params).toEqual(['t-2', 'shared'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// withLock — non-tenanted global advisory lock
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantManager.withLock', () => {
  test('opens a transaction without setting a tenant, then takes the advisory lock', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withLock('housekeeping:expire', async (tx) => {
      await tx.execute('SELECT 1')
    })
    expect(db.transactionsOpened).toBe(1)
    // Two executes: the advisory-lock SELECT + the user SQL. NO set_config.
    expect(db.executed.find((c) => c.sql.includes('set_config'))).toBeUndefined()
    const lockCall = db.executed.find((c) => c.sql.startsWith('SELECT pg_advisory_xact_lock'))
    expect(lockCall?.sql).toBe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)')
    expect(lockCall?.params).toEqual(['housekeeping:expire'])
  })

  test('currentTenantId() stays null inside the lock scope', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await tm.withLock('k', async () => {
      expect(tm.currentTenantId()).toBeNull()
    })
  })

  test('returns the callback result', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    const result = await tm.withLock('k', async () => ({ ran: true }))
    expect(result).toEqual({ ran: true })
  })

  test('rejects an empty lock key', async () => {
    const db = new FakeDb()
    const tm = new TenantManager(db)
    await expect(tm.withLock('', async () => undefined)).rejects.toThrow(/non-empty string/)
  })
})
