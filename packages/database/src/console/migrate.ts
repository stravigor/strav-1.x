/**
 * `bun strav migrate` — apply every pending migration.
 *
 * Resolves the container-bound `MigrationRunner`, auto-discovers migration
 * files from `config.database.migrationsPath`, then runs `runner.migrate()`.
 * Each migration runs in its own transaction (per `MigrationRunner`'s
 * existing semantics); per-migration boundaries make partial progress
 * recoverable. Exits 0 on success (including no-op when nothing is pending).
 */

import { Command, ExitCode } from '@strav/cli'
import { resolveMigrationRunner } from '../migrations/index.ts'

export class Migrate extends Command {
  static signature = 'migrate'
  static description = 'Run all pending migrations.'
  static providers = ['config', 'logger', 'database']

  override async execute(): Promise<number> {
    const runner = await resolveMigrationRunner(this.app)
    const result = await runner.migrate()
    if (result.applied.length === 0) {
      this.info('Nothing to migrate.')
      return ExitCode.Success
    }
    this.success(`Migrated ${result.applied.length} migration(s) — batch ${result.batch}.`)
    for (const name of result.applied) this.line(`  ✓ ${name}`)
    return ExitCode.Success
  }
}
