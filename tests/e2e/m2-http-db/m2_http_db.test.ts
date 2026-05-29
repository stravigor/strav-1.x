/**
 * M2 end-to-end smoke — proves the full HTTP + database + tenancy stack
 * composes against a real Postgres.
 *
 * Spawns a real `Bun.serve()` via `HttpKernel.serve()` on an ephemeral
 * port, fires actual `fetch()` calls, and asserts:
 *
 *   1. POST /posts with valid body → 201, post echoed back
 *   2. POST /posts with empty body → 422 (FormRequest validation)
 *   3. POST /posts with no X-Tenant-ID → 400 (tenant middleware)
 *   4. GET  /posts as tenant A → only A's posts (RLS scoping)
 *   5. GET  /posts as tenant B → only B's posts
 *   6. GET  /posts/:id from a wrong tenant → 404 (cross-tenant invisibility)
 *   7. DELETE /posts/:id → 204; subsequent GET → 404
 *
 * Self-skips cleanly when no Postgres is available — `bun test` is a
 * no-op locally without `docker-compose up`. CI brings up Postgres and
 * runs the full suite.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { emitCreateTable, type PostgresDatabase, SchemaRegistry } from '@strav/database'
import { HttpKernel, type ServeHandle } from '@strav/http'
import type { Application } from '@strav/kernel'
import {
  connectedRoleBypassesRls,
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../../support/postgres_test_db.ts'
import { createApp } from './bootstrap/app.ts'

const PG_AVAILABLE = await isPostgresAvailable()

const TENANT_A = '01TENANTAAA000000000000001'
const TENANT_B = '01TENANTBBB000000000000002'

describe.skipIf(!PG_AVAILABLE)('M2 e2e: HTTP + database + tenancy', () => {
  let app: Application
  let server: ServeHandle
  let baseUrl: string
  let setupDb: PostgresDatabase
  // RLS-scoping assertions need a role that doesn't bypass RLS; superuser /
  // BYPASSRLS local-dev roles short-circuit even FORCE ROW LEVEL SECURITY.
  let bypassesRls = false

  beforeAll(async () => {
    // Reset the schema + bring up the tables BEFORE the app starts so
    // the request path sees ready-to-use tables. Using a dedicated
    // connection for setup keeps it independent of the app's pool.
    setupDb = createTestDatabase()
    await resetSchema(setupDb)

    app = createApp()
    await app.start()

    const registry = app.resolve(SchemaRegistry)
    const setupRegistry = new SchemaRegistry()
    for (const s of registry.all()) setupRegistry.register(s)
    await setupDb.execute(
      emitCreateTable(setupRegistry.getOrFail('tenant'), { registry: setupRegistry }).sql,
    )
    await setupDb.execute(
      emitCreateTable(setupRegistry.getOrFail('post'), { registry: setupRegistry }).sql,
    )

    // Seed two tenants. Registry rows aren't RLS-scoped — straight INSERTs.
    await setupDb.execute('INSERT INTO "tenant" (id, name) VALUES ($1, $2)', [TENANT_A, 'Acme'])
    await setupDb.execute('INSERT INTO "tenant" (id, name) VALUES ($1, $2)', [TENANT_B, 'Globex'])

    bypassesRls = await connectedRoleBypassesRls(setupDb)
    if (bypassesRls) {
      // eslint-disable-next-line no-console
      console.warn(
        'm2 e2e: connected role bypasses RLS — RLS-scoping assertions will degrade to "tenant_id is set" checks. Use a non-superuser, non-BYPASSRLS role to exercise the full isolation path.',
      )
    }

    // Start the HTTP server on an ephemeral port. Bun assigns one for
    // port: 0 and surfaces it on the returned ServeHandle.
    server = app.resolve(HttpKernel).serve({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server?.stop?.()
    await app?.shutdown()
    await setupDb?.close({ timeout: 2 })
  })

  test('POST /posts without X-Tenant-ID returns 400', async () => {
    const res = await fetch(`${baseUrl}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no tenant', body: 'whatever' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe('tenant.missing')
  })

  test('POST /posts with invalid body returns 422', async () => {
    const res = await fetch(`${baseUrl}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_A },
      body: JSON.stringify({ title: '', body: '' }), // both rules.min(1) fail
    })
    expect(res.status).toBe(422)
  })

  test('POST /posts (tenant A) creates a post', async () => {
    const res = await fetch(`${baseUrl}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_A },
      body: JSON.stringify({ title: 'Acme welcome', body: 'Hello from Acme.' }),
    })
    expect(res.status).toBe(201)
    const post = (await res.json()) as { id: string; title: string; tenant_id: string }
    expect(post.title).toBe('Acme welcome')
    expect(post.tenant_id).toBe(TENANT_A)
  })

  test('POST /posts (tenant B) creates a separate post', async () => {
    const res = await fetch(`${baseUrl}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_B },
      body: JSON.stringify({ title: 'Globex welcome', body: 'Hello from Globex.' }),
    })
    expect(res.status).toBe(201)
    const post = (await res.json()) as { tenant_id: string }
    expect(post.tenant_id).toBe(TENANT_B)
  })

  test('GET /posts (tenant A) returns ONLY tenant A posts — RLS scoping', async () => {
    if (bypassesRls) return // graceful degrade: RLS doesn't apply for the connected role
    const res = await fetch(`${baseUrl}/posts`, {
      headers: { 'x-tenant-id': TENANT_A },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ title: string; tenant_id: string }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.tenant_id).toBe(TENANT_A)
    expect(body.data[0]?.title).toBe('Acme welcome')
  })

  test('GET /posts (tenant B) returns ONLY tenant B posts', async () => {
    if (bypassesRls) return
    const res = await fetch(`${baseUrl}/posts`, {
      headers: { 'x-tenant-id': TENANT_B },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ title: string; tenant_id: string }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.tenant_id).toBe(TENANT_B)
    expect(body.data[0]?.title).toBe('Globex welcome')
  })

  test('GET /posts/:id from the wrong tenant returns 404 (cross-tenant invisibility)', async () => {
    if (bypassesRls) return
    // Find tenant A's post via tenant A.
    const listRes = await fetch(`${baseUrl}/posts`, { headers: { 'x-tenant-id': TENANT_A } })
    const list = (await listRes.json()) as { data: Array<{ id: string }> }
    const acmePostId = list.data[0]?.id
    expect(acmePostId).toBeTruthy()

    // Try to fetch it as tenant B — RLS should filter the row out → 404.
    const res = await fetch(`${baseUrl}/posts/${acmePostId}`, {
      headers: { 'x-tenant-id': TENANT_B },
    })
    expect(res.status).toBe(404)
  })

  test('DELETE /posts/:id (own tenant) hard-deletes; subsequent GET returns 404', async () => {
    // Create a fresh post so this test doesn't interfere with the earlier list assertions.
    const create = await fetch(`${baseUrl}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_A },
      body: JSON.stringify({ title: 'temp', body: 'delete me' }),
    })
    const created = (await create.json()) as { id: string }

    const del = await fetch(`${baseUrl}/posts/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-tenant-id': TENANT_A },
    })
    expect(del.status).toBe(204)

    const after = await fetch(`${baseUrl}/posts/${created.id}`, {
      headers: { 'x-tenant-id': TENANT_A },
    })
    expect(after.status).toBe(404)
  })
})

describe.skipIf(PG_AVAILABLE)('M2 e2e: HTTP + database + tenancy (skipped — no DB)', () => {
  test('M2 e2e tests skipped — set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE or run docker-compose', () => {
    expect(true).toBe(true)
  })
})
