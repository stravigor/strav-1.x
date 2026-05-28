/**
 * `resolveMigrationRunner(app)` — the bridge between the container-bound
 * `MigrationRunner` (constructed empty by `DatabaseProvider`) and the
 * `migrate:*` console commands.
 *
 * Reads `config.database.migrationsPath` (defaulted to
 * `database/migrations/**\/*.ts`), runs `runner.discover(path)` to pull
 * every shipping migration into the runner, and returns it.
 *
 * Idempotent within a process: `MigrationRunner.discover` no-ops on
 * already-registered instances, so a second call from a different
 * command in the same boot is cheap.
 *
 * Lazy by design: web / queue boots don't call this helper, so they
 * don't pay the filesystem-glob + dynamic-import cost. Migration
 * commands explicitly call it as their first step.
 */

import { type Application, ConfigRepository } from '@strav/kernel'
import { type DatabaseConfigShape, DEFAULT_MIGRATIONS_PATH } from '../database_provider.ts'
import { MigrationRunner } from './runner.ts'

export async function resolveMigrationRunner(app: Application): Promise<MigrationRunner> {
  const runner = app.resolve(MigrationRunner)
  const config = app.resolve(ConfigRepository).get('database') as DatabaseConfigShape | undefined
  const raw = config?.migrationsPath ?? DEFAULT_MIGRATIONS_PATH
  const path: string | string[] = Array.isArray(raw) ? [...raw] : (raw as string)
  await runner.discover(path)
  return runner
}
