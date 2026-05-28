/**
 * Integration smoke — proves the test-Postgres rail works end-to-end.
 *
 * Covers what unit tests can't:
 *   1. `PostgresDatabase` actually connects to a live Postgres.
 *   2. DDL emitted by `emitCreateTable` is accepted by the real planner
 *      (column types, defaults, PRIMARY KEY shape, the RLS plumbing).
 *   3. `Repository<T>` round-trips rows through `Bun.SQL`.
 *   4. `TenantManager.withTenant` sets `app.tenant_id` in the transaction
 *      and RLS policies actually scope reads.
 *
 * Skips cleanly when no Postgres is available (env vars unset or
 * connection refused) so `bun test` is a no-op in environments without
 * a database. CI brings up a Postgres service and runs the full suite.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  Archetype,
  defineSchema,
  emitCreateTable,
  Model,
  type ModelClass,
  type PostgresDatabase,
  Repository,
  SchemaRegistry,
  TenantManager,
} from '../../packages/database/src/index.ts'
import { EventBus } from '../../packages/kernel/src/index.ts'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../support/postgres_test_db.ts'

const PG_AVAILABLE = await isPostgresAvailable()

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const tenantSchema = defineSchema(
  'tenant',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('name').max(120)
    t.timestamps()
  },
  { tenantRegistry: true },
)

const postSchema = defineSchema(
  'post',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('title').max(255)
    t.timestamps()
  },
  { tenanted: true },
)

class Post extends Model {
  static override readonly schema = postSchema
  id!: string
  tenant_id!: string
  title!: string
  created_at!: Date
  updated_at!: Date
}

class PostRepository extends Repository<Post> {
  static override readonly schema = postSchema
  static override readonly model: ModelClass = Post as unknown as ModelClass
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoke suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('integration: Postgres smoke', () => {
  let db: PostgresDatabase
  let registry: SchemaRegistry

  beforeAll(async () => {
    db = createTestDatabase()
    await resetSchema(db)

    registry = new SchemaRegistry()
    registry.register(tenantSchema)
    registry.register(postSchema)

    // Bring up the tables with the framework's DDL emitter. Real planner
    // accepts what `emitCreateTable` produces — including the RLS plumbing
    // for the tenanted schema.
    await db.execute(emitCreateTable(tenantSchema, { registry }).sql)
    await db.execute(emitCreateTable(postSchema, { registry }).sql)
  })

  afterAll(async () => {
    await db.close({ timeout: 2 })
  })

  test('PostgresDatabase connects + runs SELECT 1', async () => {
    const row = await db.queryOne<{ ok: number }>('SELECT 1 AS ok')
    expect(row?.ok).toBe(1)
  })

  test('emitCreateTable DDL was accepted: tenant + post tables exist with the right columns', async () => {
    const tenantCols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      ['tenant'],
    )
    expect(tenantCols.map((c) => c.column_name)).toEqual(['id', 'name', 'created_at', 'updated_at'])

    const postCols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      ['post'],
    )
    expect(postCols.map((c) => c.column_name)).toEqual([
      'id',
      'tenant_id',
      'title',
      'created_at',
      'updated_at',
    ])
  })

  test('RLS is enabled on the tenanted table', async () => {
    const row = await db.queryOne<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname='post'`,
    )
    expect(row?.relrowsecurity).toBe(true)
  })

  test('TenantManager.withTenant isolates reads + writes per tenant', async () => {
    // Seed two tenants directly (the registry table is NOT RLS-scoped).
    await db.execute('INSERT INTO "tenant" (id, name) VALUES ($1, $2)', [
      '01TENANTAAA000000000000001',
      'Acme',
    ])
    await db.execute('INSERT INTO "tenant" (id, name) VALUES ($1, $2)', [
      '01TENANTBBB000000000000002',
      'Globex',
    ])

    const tenants = new TenantManager(db, new EventBus())

    // Acme creates a post — only Acme should see it via Repository.
    await tenants.withTenant('01TENANTAAA000000000000001', async () => {
      const posts = new PostRepository(db)
      await posts.create({
        tenant_id: '01TENANTAAA000000000000001',
        title: 'Acme welcome',
      } as unknown as Partial<Post>)
    })

    // Globex creates its own post.
    await tenants.withTenant('01TENANTBBB000000000000002', async () => {
      const posts = new PostRepository(db)
      await posts.create({
        tenant_id: '01TENANTBBB000000000000002',
        title: 'Globex welcome',
      } as unknown as Partial<Post>)
    })

    // From Acme's tenant scope, only Acme rows are visible.
    const acmeView = await tenants.withTenant('01TENANTAAA000000000000001', async () => {
      const posts = new PostRepository(db)
      return posts.all()
    })
    expect(acmeView).toHaveLength(1)
    expect(acmeView[0]?.title).toBe('Acme welcome')

    // From Globex's tenant scope, only Globex rows.
    const globexView = await tenants.withTenant('01TENANTBBB000000000000002', async () => {
      const posts = new PostRepository(db)
      return posts.all()
    })
    expect(globexView).toHaveLength(1)
    expect(globexView[0]?.title).toBe('Globex welcome')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// When Postgres is not available — keep a visible signal so the test
// runner reports "0 ran, 1 skipped" instead of silent disappearance.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(PG_AVAILABLE)('integration: Postgres smoke (skipped — no DB)', () => {
  test('Postgres integration tests skipped — set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE or run docker-compose', () => {
    expect(true).toBe(true)
  })
})
