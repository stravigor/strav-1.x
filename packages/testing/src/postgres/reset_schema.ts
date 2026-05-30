/**
 * Drop + recreate the `public` schema on the connected database.
 * Bulletproof isolation between integration test runs at the cost of
 * a sledgehammer — the integration test database owns its state and
 * shouldn't be pointed at anything precious.
 */

import type { PostgresDatabase } from '@strav/database'

export async function resetSchema(db: PostgresDatabase): Promise<void> {
  await db.execute('DROP SCHEMA IF EXISTS public CASCADE')
  await db.execute('CREATE SCHEMA public')
  await db.execute('GRANT ALL ON SCHEMA public TO public')
}
