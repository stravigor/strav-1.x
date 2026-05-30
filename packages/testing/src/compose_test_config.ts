/**
 * Merge per-test config overrides with the standard test defaults.
 *
 * Defaults supplied:
 *
 *   - `logger`: silent + stderr channel — keeps `bun test` output clean.
 *   - `database.url`: composed from `DB_*` env vars via `testDatabaseUrl()`.
 *
 * Both are deep-merged with `overrides`. Pass `logger` or `database` in
 * `overrides` to replace the default for that key. Other keys
 * (`rag`, `payment`, `social`, `encryption`, etc.) are taken verbatim
 * from `overrides`.
 *
 * Throws when `DB_*` env vars are missing AND no `database.url` override
 * is supplied — `bootTestApp` callers gate via `isPostgresAvailable()`
 * first, so the throw should only fire in misconfigured environments.
 */

import { testDatabaseUrl } from './postgres/test_database_url.ts'

export type ConfigOverrides = Record<string, unknown>

const DEFAULT_LOGGER = {
  default: 'main',
  level: 'silent',
  channels: { main: { driver: 'stderr' } },
} as const

export function composeTestConfig(overrides: ConfigOverrides = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...overrides }

  if (!('logger' in merged)) {
    merged.logger = { ...DEFAULT_LOGGER }
  }

  if (!('database' in merged)) {
    const url = testDatabaseUrl()
    if (url === null) {
      throw new Error(
        'composeTestConfig: missing DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_DATABASE env. Source .env.test, run docker-compose up, or pass `database` explicitly in overrides.',
      )
    }
    merged.database = { url }
  }

  return merged
}
