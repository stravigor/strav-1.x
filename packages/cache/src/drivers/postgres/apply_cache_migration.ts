/**
 * `applyCacheMigration` — emit DDL for the three tables `PostgresCache`
 * uses.
 *
 *   - `strav_cache (key text PK, data jsonb, expires_at timestamptz NULL)`
 *     — the main key/value store. `expires_at` indexed for the
 *     periodic sweep.
 *   - `strav_cache_locks (name text PK, owner text NOT NULL,
 *     expires_at timestamptz NOT NULL)` — distributed-lock slots.
 *   - `strav_cache_tags (key text NOT NULL, tag text NOT NULL,
 *     PRIMARY KEY (key, tag))` — tag-to-key index. `tag` indexed
 *     for the flush path. FK to `strav_cache.key` ON DELETE CASCADE
 *     so cache-entry deletion takes its tag wiring with it.
 *
 * Schemas are NOT registered with the SchemaRegistry because the cache
 * table layout (text PK, composite PK on tags) doesn't fit the schema
 * DSL — apps just invoke this helper from a migration `up()` and DROP
 * the tables in `down()`.
 */

import type { DatabaseExecutor } from '@strav/database'

export async function applyCacheMigration(db: DatabaseExecutor): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS "strav_cache" (
       "key" text PRIMARY KEY,
       "data" jsonb NOT NULL,
       "expires_at" timestamptz NULL
     )`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_strav_cache_expires_at"
     ON "strav_cache" ("expires_at")
     WHERE "expires_at" IS NOT NULL`,
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS "strav_cache_locks" (
       "name" text PRIMARY KEY,
       "owner" text NOT NULL,
       "expires_at" timestamptz NOT NULL
     )`,
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS "strav_cache_tags" (
       "key" text NOT NULL,
       "tag" text NOT NULL,
       PRIMARY KEY ("key", "tag"),
       FOREIGN KEY ("key") REFERENCES "strav_cache" ("key") ON DELETE CASCADE
     )`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_strav_cache_tags_tag" ON "strav_cache_tags" ("tag")`,
  )
}
