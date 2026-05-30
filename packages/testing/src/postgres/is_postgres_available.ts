/**
 * Cheap connection probe with a short timeout. Cached for the lifetime
 * of the test process — connection state doesn't flip mid-suite.
 *
 * Returns `false` if env is missing OR the connection attempt fails
 * (Postgres down, wrong creds, network unreachable). Pair with
 * `describe.skipIf(!await isPostgresAvailable())` so suites that need
 * a real Postgres self-skip when it's not reachable.
 */

import { PostgresDatabase } from '@strav/database'
import { testDatabaseUrl } from './test_database_url.ts'

let cachedAvailability: boolean | null = null

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
