import { camel, MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeFactory extends MakeCommand {
  static signature = 'make:factory {name}'
  static description = 'Create a factory stub for a model.'
  static providers: string[] = []

  protected filePath(name: string): string {
    const base = snake(name).replace(/_factory$/, '')
    return `database/factories/${base}_factory.ts`
  }

  protected stub(name: string): string {
    const base = pascal(name).replace(/Factory$/, '')
    return `import type { ${base} } from '../../app/models/${snake(base)}.ts'

export function ${camel(base)}Factory(overrides: Partial<${base}> = {}): ${base} {
  return {
    // define default attribute values here
    ...overrides,
  } as ${base}
}
`
  }
}
