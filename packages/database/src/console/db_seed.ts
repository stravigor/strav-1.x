/**
 * `bun strav db:seed [--seeder=ClassName] [--path=database/seeders]`
 *
 * Discovers every `DatabaseSeeder` under `config.database.seedersPath`
 * (default `database/seeders/**\/*.ts`), instantiates them, and calls
 * `seeder.run(db)` in discovery order.
 *
 * `--seeder=ClassName` limits execution to the single seeder whose
 * export name matches (case-sensitive).
 *
 * Apps configure the glob in `config/database.ts`:
 *   `seedersPath: 'database/seeders/**\/*.ts'`
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { ConfigRepository } from '@strav/kernel'
import { type DatabaseConfigShape, PostgresDatabase } from '../index.ts'
import { discoverSeeders } from '../seeders.ts'

export class DbSeed extends Command {
  static signature = 'db:seed {--seeder=} {--path=}'
  static description = 'Run database seeders.'
  static providers = ['config', 'logger', 'database']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const config = this.app.resolve(ConfigRepository).get('database') as
      | DatabaseConfigShape
      | undefined
    const cwd = process.cwd()

    const rawPath =
      (flags.path as string | undefined) ||
      (config as { seedersPath?: string } | undefined)?.seedersPath ||
      'database/seeders/**/*.ts'

    const filter = flags.seeder as string | undefined

    const seeders = await discoverSeeders(rawPath, { cwd })

    if (seeders.length === 0) {
      this.info('No seeders found.')
      return ExitCode.Success
    }

    const toRun = filter ? seeders.filter((s) => s.name === filter) : seeders

    if (filter && toRun.length === 0) {
      this.error(
        `Seeder "${filter}" not found. Available: ${seeders.map((s) => s.name).join(', ')}`,
      )
      return ExitCode.DataError
    }

    const db = this.app.resolve(PostgresDatabase)
    let count = 0
    for (const { name, instance } of toRun) {
      this.info(`Running ${name}…`)
      await instance.run(db)
      this.success(`  ✓ ${name}`)
      count++
    }

    this.success(`Seeded ${count} seeder(s).`)
    return ExitCode.Success
  }
}
