import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeRepository extends MakeCommand {
  static signature = 'make:repository {name}'
  static description = 'Create a Repository stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    const base = snake(name).replace(/_repository$/, '')
    return `app/repositories/${base}_repository.ts`
  }

  protected stub(name: string): string {
    const base = pascal(name).replace(/Repository$/, '')
    const cls = `${base}Repository`
    const model = base
    return `import { inject } from '@strav/kernel'
import { type Database, PostgresDatabase, Repository } from '@strav/database'
import { ${model} } from '../models/${snake(model)}.ts'
import { ${snake(model)}Schema } from '../../database/schemas/${snake(model)}_schema.ts'

@inject()
export class ${cls} extends Repository<${model}> {
  constructor(db: PostgresDatabase) {
    super(db, ${snake(model)}Schema)
  }
}
`
  }
}
