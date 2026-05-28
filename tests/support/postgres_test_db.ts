/**
 * Test helper for integration tests that need a real Postgres connection.
 *
 * Reads the standard env-var contract (`DB_HOST` / `DB_PORT` / `DB_USER` /
 * `DB_PASSWORD` / `DB_DATABASE`) shared with CI. When any required var is
 * missing OR a connection can't be established, `isPostgresAvailable()`
 * returns `false` and the suite self-skips — so `bun test` is a no-op for
 * integration tests in environments without a local Postgres.
 *
 * For full isolation between test runs, `resetSchema(db)` drops + recreates
 * the `public` schema. Nuclear, but the integration suite owns the test
 * database — there's nothing user-facing in `public` to preserve.
 *
 * Local dev: `docker-compose up -d` brings up Postgres matching the CI
 * service config; copy `.env.test.example` to `.env.test` and source it.
 */

import { PostgresDatabase } from '../../packages/database/src/index.ts'

interface PgEnv {
  host: string
  port: string
  user: string
  password: string
  database: string
}

function readPgEnv(): PgEnv | null {
  const host = process.env.DB_HOST
  const port = process.env.DB_PORT
  const user = process.env.DB_USER
  const password = process.env.DB_PASSWORD
  const database = process.env.DB_DATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

/** Assemble a Postgres URL from the standard env-var contract. */
export function testDatabaseUrl(): string | null {
  const env = readPgEnv()
  if (env === null) return null
  // `encodeURIComponent` so a password containing `@` or `:` doesn't corrupt the URL.
  return `postgres://${env.user}:${encodeURIComponent(env.password)}@${env.host}:${env.port}/${env.database}`
}

let cachedAvailability: boolean | null = null

/**
 * Cheap connection probe with a short timeout. Cached for the lifetime of
 * the test process — connection state doesn't flip mid-suite. Returns
 * `false` if env is missing OR the connection attempt fails (Postgres
 * down, wrong creds, network unreachable).
 */
export async function isPostgresAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  const url = testDatabaseUrl()
  if (url === null) {
    cachedAvailability = false
    return false
  }
  try {
    const probe = new PostgresDatabase({ url, max: 1 })
    await probe.queryOne('SELECT 1 AS ok')
    await probe.close({ timeout: 1 })
    cachedAvailability = true
    return true
  } catch {
    cachedAvailability = false
    return false
  }
}

/**
 * Construct a fresh `PostgresDatabase` against the test connection. Caller
 * is responsible for `close()` — typically in an `afterAll` hook.
 */
export function createTestDatabase(): PostgresDatabase {
  const url = testDatabaseUrl()
  if (url === null) {
    throw new Error(
      'createTestDatabase: missing DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_DATABASE env. Source .env.test or run docker-compose up.',
    )
  }
  return new PostgresDatabase({ url, max: 2 })
}

/**
 * Drop + recreate the `public` schema on the connected database. Bulletproof
 * isolation between integration test runs at the cost of a sledgehammer —
 * the integration test database owns its state and shouldn't be pointed at
 * anything precious.
 */
export async function resetSchema(db: PostgresDatabase): Promise<void> {
  await db.execute('DROP SCHEMA IF EXISTS public CASCADE')
  await db.execute('CREATE SCHEMA public')
  await db.execute('GRANT ALL ON SCHEMA public TO public')
}
