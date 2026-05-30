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
    return `import { Repository } from '@strav/database'
import { ${model} } from '../models/${snake(model)}.ts'
import { ${snake(model)}Schema } from '../../database/schemas/${snake(model)}_schema.ts'

export class ${cls} extends Repository<${model}> {
  static override readonly schema = ${snake(model)}Schema
  static override readonly model = ${model}
}

// Bind in your ServiceProvider:
//
//   app.singleton(${cls}, (c) => new ${cls}({
//     db: c.resolve(PostgresDatabase),
//     events: c.resolve(EventBus),
//   }))
`
  }
}
