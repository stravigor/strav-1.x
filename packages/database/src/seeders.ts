/**
 * Seeder contract + discovery.
 *
 * A seeder is any exported class (or object) with a `run(db)` method:
 *
 *   ```ts
 *   // database/seeders/reference_data_seeder.ts
 *   import type { DatabaseSeeder } from '@strav/database'
 *   import type { Database } from '@strav/database'
 *
 *   export class ReferenceDataSeeder implements DatabaseSeeder {
 *     async run(db: Database): Promise<void> {
 *       await db.execute(`INSERT INTO countries (code, name) VALUES ('US', 'United States')`)
 *     }
 *   }
 *   ```
 *
 * `discoverSeeders(pattern, opts?)` walks the glob, imports each file,
 * and returns every exported value that satisfies the contract. Silently
 * skips files that export nothing seeder-shaped (same pattern as
 * MigrationRunner.discover).
 */

import type { Database } from './database.ts'

export interface DatabaseSeeder {
  run(db: Database): Promise<void>
}

/** Type-guard: a value looks like a DatabaseSeeder. */
function isSeeder(value: unknown): value is { new (): DatabaseSeeder } | DatabaseSeeder {
  if (typeof value === 'function') {
    // Class constructor: instantiate and check prototype
    return typeof (value as { prototype?: { run?: unknown } }).prototype?.run === 'function'
  }
  if (typeof value === 'object' && value !== null) {
    return typeof (value as { run?: unknown }).run === 'function'
  }
  return false
}

export interface DiscoveredSeeder {
  name: string
  /** Instantiates (for class exports) or wraps (for object exports). */
  instance: DatabaseSeeder
}

/**
 * Auto-discover seeders by glob. Returns one `DiscoveredSeeder` per
 * exported class or object that satisfies `DatabaseSeeder`. Files that
 * export nothing seeder-shaped are silently skipped.
 */
export async function discoverSeeders(
  pattern: string | string[],
  options: { cwd?: string } = {},
): Promise<DiscoveredSeeder[]> {
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  const cwd = options.cwd ?? process.cwd()
  const files = new Set<string>()
  for (const p of patterns) {
    const glob = new Bun.Glob(p)
    for await (const file of glob.scan({ cwd, absolute: true })) {
      files.add(file)
    }
  }

  const seeders: DiscoveredSeeder[] = []
  for (const file of files) {
    const mod = (await import(file)) as Record<string, unknown>
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isSeeder(value)) continue
      const instance =
        typeof value === 'function'
          ? new (value as new () => DatabaseSeeder)()
          : (value as DatabaseSeeder)
      seeders.push({ name: exportName, instance })
    }
  }
  return seeders
}
