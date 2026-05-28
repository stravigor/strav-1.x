/**
 * `DatabaseConsoleProvider` — declares the migration console commands.
 *
 * Apps add it to `bootstrap/providers.ts` (lockstep with `DatabaseProvider`).
 * `runCli` walks the provider list once and pulls every `commands` array off
 * `ConsoleProvider` subclasses, so apps don't have to wire commands a
 * second time.
 *
 * Why a separate provider (not part of `DatabaseProvider`): `DatabaseProvider`
 * lives in the dependency graph of nearly every workload (web server, queue
 * worker, scheduler). `ConsoleProvider` subclasses are only meaningful when
 * the CLI is the entry point. Keeping the two split lets non-console
 * processes skip the CLI overhead entirely.
 */

import { ConsoleProvider } from '@strav/cli'
import { DbSeed } from './db_seed.ts'
import { Migrate } from './migrate.ts'
import { MigrateFresh } from './migrate_fresh.ts'
import { MigrateGenerate } from './migrate_generate.ts'
import { MigrateRollback } from './migrate_rollback.ts'
import { MigrateStatus } from './migrate_status.ts'

export class DatabaseConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.database'
  override readonly commands = [
    Migrate,
    MigrateRollback,
    MigrateStatus,
    MigrateFresh,
    MigrateGenerate,
    DbSeed,
  ] as const
}
