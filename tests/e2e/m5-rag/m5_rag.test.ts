/**
 * M5 end-to-end smoke — proves `@strav/rag` end-to-end against a
 * real Postgres + pgvector instance.
 *
 * Closes the M5 exit-checklist item:
 *   "M5 e2e covers rag"
 *
 * The wire under test:
 *
 *   ArticleRepository.create(...)            ← domain repo
 *     → INSERT into article (tenanted, RLS)
 *
 *   articles.vectorize(article)              ← retrievable() mixin
 *     → RagManager.ingest(...)
 *       → chunker.chunk(...) → BrainManager.embed(...)
 *       → PgvectorDriver.upsert(...)
 *         → INSERT into rag_vector (tenanted, vector(N))
 *
 *   articles.retrieve(query)                 ← retrievable() mixin
 *     → BrainManager.embed([query])
 *     → PgvectorDriver.query(...)
 *       → SELECT ... ORDER BY embedding <=> ::vector
 *
 *   articles.resolveMatches(matches)         ← retrievable() mixin
 *     → Repository.findMany(sourceIds)
 *
 *   tenants.withTenant(tenantId, ...)        ← per-call RLS scope
 *
 * Self-skips when no Postgres is available — matches the
 * integration suites' contract. CI provisions
 * `pgvector/pgvector:pg16`; local dev runs `docker-compose up`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  PostgresDatabase,
  TenantManager,
} from '@strav/database'
import { EventBus, ulid } from '@strav/kernel'
import {
  applyRagVectorMigration,
  RagManager,
  RagProvider,
  ragVectorSchema,
} from '@strav/rag'
import {
  bootTestApp,
  type BootTestAppResult,
  isPostgresAvailable,
} from '@strav/testing'
import { stubBrainProvider } from '@strav/testing/brain'
import { Article } from './app/article.ts'
import { ArticleRepository } from './app/article_repository.ts'
import { articleSchema } from './database/schemas/article_schema.ts'
import { tenantSchema } from './database/schemas/tenant_schema.ts'

const PG_AVAILABLE = await isPostgresAvailable()

// ─── Deterministic embedder ─────────────────────────────────────────────

/**
 * Bag-of-words style 4-dim unit vector. Similar text → similar vector,
 * so retrieval-order assertions hold. Tokens are word characters
 * lowercased; the helper hashes each token into one of 4 bins, then
 * normalizes. Cheap enough to inline; deterministic enough to assert.
 */
function bagOfWordsEmbedding(text: string): number[] {
  const tokens = text.toLowerCase().match(/\w+/g) ?? []
  const v = [0, 0, 0, 0]
  for (const tok of tokens) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0
    v[((h >>> 0) & 3)]! += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

// ─── DDL + seed helpers ─────────────────────────────────────────────────

async function seedTenant(db: PostgresDatabase, name: string): Promise<string> {
  const id = ulid()
  await db.execute(
    `INSERT INTO "tenant" ("id", "name") VALUES ($1, $2)`,
    [id, name],
  )
  return id
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('M5 e2e: rag end-to-end against Postgres + pgvector', () => {
  let booted: BootTestAppResult
  let db: PostgresDatabase
  let tenants: TenantManager
  let articles: ArticleRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    booted = await bootTestApp({
      config: {
        rag: {
          default: 'pg',
          embedding: {
            provider: 'stub',
            model: 'stub-embedder',
            dimension: 4,
          },
          chunking: {
            // The recursive chunker greedy-merges; 256 chars is
            // plenty for the seeded articles to stay in one chunk.
            strategy: 'recursive',
            chunkSize: 256,
            overlap: 0,
          },
          stores: { pg: { driver: 'pgvector' } },
        },
      },
      schemas: [tenantSchema, articleSchema, ragVectorSchema],
      migrations: [
        (db, registry) => applyRagVectorMigration(db, { dimension: 4, registry }),
      ],
      providers: [
        // Stub BrainManager BEFORE RagProvider boots so RagProvider's
        // resolution picks up the stub (declares name: 'brain').
        stubBrainProvider({ embed: bagOfWordsEmbedding, model: 'stub-embedder' }),
        new RagProvider(),
      ],
    })

    db = booted.setupDb
    tenants = booted.app.resolve(TenantManager)
    articles = new ArticleRepository(
      {
        db: booted.app.resolve(PostgresDatabase),
        events: booted.app.resolve(EventBus),
      },
      booted.app.resolve(RagManager),
    )

    tenantA = await seedTenant(db, 'Acme')
    tenantB = await seedTenant(db, 'Globex')
  })

  afterAll(() => booted.dispose())

  // ─── End-to-end ingest + retrieve ───────────────────────────────────

  test('vectorize → retrieve → resolveMatches against pgvector', async () => {
    await tenants.withTenant(tenantA, async () => {
      const a1 = await articles.create({
        tenant_id: tenantA,
        title: 'Compaction in long Anthropic threads',
        body: 'Compaction summarizes older turns into a single block so long threads stay in budget.',
      } as Partial<Article>)
      const a2 = await articles.create({
        tenant_id: tenantA,
        title: 'Multitenancy via RLS',
        body: 'Row-level security policies scope queries by current_setting tenant id.',
      } as Partial<Article>)
      const a3 = await articles.create({
        tenant_id: tenantA,
        title: 'Tool forcing in OpenAI-compat providers',
        body: 'The synthetic respond_with tool gives JSON-schema output through function calling.',
      } as Partial<Article>)

      const ids = await articles.vectorize(a1)
      expect(ids.length).toBeGreaterThan(0)
      await articles.vectorize(a2)
      await articles.vectorize(a3)

      const { matches } = await articles.retrieve('compaction threads')
      expect(matches.length).toBeGreaterThan(0)
      // The compaction article must rank first — its content
      // shares the most tokens with the query under the
      // stub embedder.
      expect(matches[0]?.sourceId).toBe(a1.id)

      const rows = await articles.resolveMatches(matches)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0]?.id).toBe(a1.id)
      expect(rows[0]).toBeInstanceOf(Article)
    })
  })

  // ─── retrievable() drops + re-ingests on re-vectorize ───────────────

  test('re-vectorize on the same model drops old chunks', async () => {
    await tenants.withTenant(tenantA, async () => {
      const article = await articles.create({
        tenant_id: tenantA,
        title: 'Drafty title',
        body: 'first version body content',
      } as Partial<Article>)
      await articles.vectorize(article)

      const initial = await articles.retrieve('first version')
      const firstMatch = initial.matches.find((m) => m.sourceId === article.id)
      expect(firstMatch).toBeDefined()

      // Update body + re-vectorize. The mixin must drop the old chunks
      // before re-ingesting; otherwise both versions would coexist.
      article.body = 'second version body content'
      await articles.update(article, { body: 'second version body content' })
      await articles.vectorize(article)

      const after = await articles.retrieve('first version')
      const stale = after.matches.find(
        (m) => m.sourceId === article.id && m.content.includes('first version'),
      )
      expect(stale).toBeUndefined()
    })
  })

  // ─── vectorRemove drops every chunk for one source ──────────────────

  test('vectorRemove drops every chunk for one source', async () => {
    await tenants.withTenant(tenantA, async () => {
      const article = await articles.create({
        tenant_id: tenantA,
        title: 'To be removed',
        body: 'About to vanish from the index.',
      } as Partial<Article>)
      await articles.vectorize(article)
      let probe = await articles.retrieve('about to vanish')
      expect(probe.matches.find((m) => m.sourceId === article.id)).toBeDefined()

      await articles.vectorRemove(article)
      probe = await articles.retrieve('about to vanish')
      expect(probe.matches.find((m) => m.sourceId === article.id)).toBeUndefined()
    })
  })

  // ─── Multitenancy: tenant_id is filled per-tenant on every write ────

  test('every write inside withTenant stamps the correct tenant_id on rag_vector', async () => {
    // Tenant A ingests an article with a distinctive term.
    await tenants.withTenant(tenantA, async () => {
      const a = await articles.create({
        tenant_id: tenantA,
        title: 'Acme widget catalog',
        body: 'Magenta pyramids and turquoise spheres.',
      } as Partial<Article>)
      await articles.vectorize(a)
    })

    // Tenant B ingests an article with a different distinctive term.
    await tenants.withTenant(tenantB, async () => {
      const a = await articles.create({
        tenant_id: tenantB,
        title: 'Globex sprocket manual',
        body: 'Cerulean toroids and crimson dodecahedra.',
      } as Partial<Article>)
      await articles.vectorize(a)
    })

    // Verify tenant_id was stamped correctly on the rag_vector
    // rows. RLS isolation itself is verified at the
    // database/integration suite level — superuser connections
    // bypass RLS, so we assert the data shape that RLS will
    // enforce when running under a non-privileged role in
    // production.
    const acmeRows = await db.query<{ tenant_id: string; content: string }>(
      `SELECT tenant_id, content FROM "rag_vector" WHERE content LIKE $1`,
      ['%Magenta pyramids%'],
    )
    expect(acmeRows.length).toBeGreaterThan(0)
    for (const row of acmeRows) {
      expect(row.tenant_id).toBe(tenantA)
    }

    const globexRows = await db.query<{ tenant_id: string; content: string }>(
      `SELECT tenant_id, content FROM "rag_vector" WHERE content LIKE $1`,
      ['%Cerulean toroids%'],
    )
    expect(globexRows.length).toBeGreaterThan(0)
    for (const row of globexRows) {
      expect(row.tenant_id).toBe(tenantB)
    }
  })
})
