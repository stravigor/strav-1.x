/**
 * Construct a fresh `PostgresDatabase` against the test connection. The
 * caller owns the close — typically in an `afterAll` hook.
 *
 * Throws when env is missing; tests that don't want the throw should
 * gate via `isPostgresAvailable()` first.
 */

import { PostgresDatabase } from '@strav/database'
import { testDatabaseUrl } from './test_database_url.ts'

export function createTestDatabase(): PostgresDatabase {
  const url = testDatabaseUrl()
  if (url === null) {
    throw new Error(
      'createTestDatabase: missing DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_DATABASE env. Source .env.test or run docker-compose up.',
    )
  }
  return new PostgresDatabase({ url, max: 2 })
}
