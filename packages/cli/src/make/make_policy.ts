import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakePolicy extends MakeCommand {
  static signature = 'make:policy {name}'
  static description = 'Create an authorization policy stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    const base = snake(name).replace(/_policy$/, '')
    return `app/policies/${base}_policy.ts`
  }

  protected stub(name: string): string {
    const base = pascal(name).replace(/Policy$/, '')
    const cls = `${base}Policy`
    return `export class ${cls} {
  // async view(user: User, model: ${base}): Promise<boolean> { return true }
  // async create(user: User): Promise<boolean> { return true }
  // async update(user: User, model: ${base}): Promise<boolean> { return true }
  // async delete(user: User, model: ${base}): Promise<boolean> { return true }
}
`
  }
}
