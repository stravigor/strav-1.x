#!/usr/bin/env bun
/**
 * Reset the test Postgres database.
 *
 * Connects to whatever `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD`
 * point at, drops + recreates the `DB_DATABASE` schema (via `DROP SCHEMA
 * public CASCADE` + `CREATE SCHEMA public`), and exits 0.
 *
 * Useful when local dev gets into a weird state (a half-applied migration,
 * stuck advisory locks, leftover data). Re-running the integration tests
 * resets state by itself, but this gives developers a single explicit
 * "start over" button. Safe to run repeatedly — idempotent.
 *
 * The script targets the database named in `DB_DATABASE` (not "postgres"),
 * so it won't accidentally wipe a developer's primary database — but it
 * still nukes everything in the configured public schema. Don't point
 * `DB_DATABASE` at anything precious.
 *
 * Run:
 *   bun scripts/db-setup.ts
 * Or via the package.json script:
 *   bun run db:setup
 */

import { SQL } from 'bun'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`db-setup: missing env var ${name}. Source .env.test (see .env.test.example).`)
    process.exit(1)
  }
  return value
}

const host = requireEnv('DB_HOST')
const port = requireEnv('DB_PORT')
const user = requireEnv('DB_USER')
const password = requireEnv('DB_PASSWORD')
const database = requireEnv('DB_DATABASE')

const url = `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`

const sql = new SQL(url, { max: 1 })

try {
  console.log(`db-setup: resetting public schema on ${host}:${port}/${database}…`)
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
  await sql.unsafe('CREATE SCHEMA public')
  await sql.unsafe('GRANT ALL ON SCHEMA public TO public')
  console.log('db-setup: done.')
  await sql.close({ timeout: 2 })
  process.exit(0)
} catch (err) {
  console.error('db-setup: failed:', (err as Error).message)
  await sql.close({ timeout: 2 }).catch(() => undefined)
  process.exit(1)
}
