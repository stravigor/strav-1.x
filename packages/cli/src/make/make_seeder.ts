import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeSeeder extends MakeCommand {
  static signature = 'make:seeder {name}'
  static description = 'Create a database seeder stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `database/seeders/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name).endsWith('Seeder') ? pascal(name) : `${pascal(name)}Seeder`
    return `import type { Database } from '@strav/database'

export class ${cls} {
  async run(db: Database): Promise<void> {
    // seed your data here
  }
}
`
  }
}
