/**
 * Cheap connection probe — opens `Bun.RedisClient` against
 * `REDIS_URL`, sends `PING`, reports. Cached for the lifetime of the
 * test process.
 *
 * Returns `false` if `REDIS_URL` is missing OR the connection / PING
 * fails. Pair with `describe.skipIf(!await isRedisAvailable())`.
 */

import { RedisClient } from 'bun'

let cachedAvailability: boolean | null = null

export async function isRedisAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  const url = process.env['REDIS_URL']
  if (url === undefined || url === '') {
    cachedAvailability = false
    return false
  }
  let client: RedisClient | undefined
  try {
    client = new RedisClient(url)
    // `send('PING', [])` is supported on every Bun.RedisClient build —
    // safer than `ping()` which isn't on the typed surface.
    const reply = await client.send('PING', [])
    cachedAvailability = reply === 'PONG' || reply === 'OK' || typeof reply === 'string'
    return cachedAvailability
  } catch {
    cachedAvailability = false
    return false
  } finally {
    try {
      client?.close()
    } catch {
      // Already closed / never connected — nothing to clean.
    }
  }
}
