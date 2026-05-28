import { UsageError } from '../binder.ts'
import type { ExecuteArgs } from '../command.ts'
import { MakeCommand } from '../make_command.ts'

export class MakeMigration extends MakeCommand {
  static signature = 'make:migration {--message=}'
  static description = 'Create a migration file stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `database/migrations/${name}.ts`
  }

  protected stub(name: string): string {
    return `import type { Migration } from '@strav/database'

export const migration: Migration = {
  name: '${name}',
  async up(db) {
    // write your migration here
  },
  async down(db) {
    // write your rollback here
  },
}
`
  }

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const msg = (flags.message as string | undefined)?.trim()
    if (!msg) {
      throw new UsageError(
        '--message (or -m) is required: bun strav make:migration -m "create users"',
      )
    }
    const slug = msg
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!slug)
      throw new UsageError(`--message "${msg}" produced an empty slug — use letters / digits`)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    const name = `${ts}_${slug}`
    return super.execute({ args: { name }, flags })
  }
}
