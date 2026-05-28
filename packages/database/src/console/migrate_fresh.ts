/**
 * `bun strav migrate:fresh` — drop the public schema and re-migrate.
 *
 * Hard-locked to `APP_ENV` in {`local`, `testing`} — running this against
 * staging or production would obliterate every row. Prompts for
 * confirmation unless `--force`. Uses the `AdminDatabase` pool when one
 * is bound (so the bypass-RLS role drops cleanly across tenant tables);
 * falls back to the primary `Database` otherwise.
 *
 * Steps: DROP SCHEMA public CASCADE → CREATE SCHEMA public → migrate().
 * Cascades through every tenant table the registry knows about plus any
 * objects the framework's tracking table holds. The `_strav_migrations`
 * table is dropped along with everything else; `MigrationRunner.migrate()`
 * recreates it.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { AdminDatabase, type Database, PostgresDatabase } from '../database.ts'
import { resolveMigrationRunner } from '../migrations/index.ts'

export class MigrateFresh extends Command {
  static signature = 'migrate:fresh {--force}'
  static description =
    'Drop the public schema and re-run every migration. APP_ENV=local|testing only.'
  static providers = ['config', 'logger', 'database']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    if (!this.app.isLocal() && !this.app.isTesting()) {
      this.error(
        `migrate:fresh refuses to run when APP_ENV=${this.app.env()}. Use local/testing only.`,
      )
      return ExitCode.ConfigError
    }

    if (flags.force !== true) {
      const ok = await this.confirm(
        'This will DROP every table in the public schema and re-run all migrations. Continue?',
      )
      if (!ok) {
        this.info('Aborted.')
        return ExitCode.Success
      }
    }

    // Prefer the admin pool when one is bound (its role is allowed to bypass
    // RLS and to drop objects another role owns). Fall back to the primary
    // pool — in single-role setups it owns the schema itself.
    const db: Database = this.app.has(AdminDatabase)
      ? (this.app.resolve(AdminDatabase) as Database)
      : (this.app.resolve(PostgresDatabase) as Database)

    await db.execute('DROP SCHEMA public CASCADE')
    await db.execute('CREATE SCHEMA public')
    this.warn('Dropped + recreated public schema.')

    const runner = await resolveMigrationRunner(this.app)
    const result = await runner.migrate()
    this.success(
      `Database refreshed — applied ${result.applied.length} migration(s) (batch ${result.batch}).`,
    )
    return ExitCode.Success
  }
}
