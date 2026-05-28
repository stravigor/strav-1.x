import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeController extends MakeCommand {
  static signature = 'make:controller {name}'
  static description = 'Create a new HTTP controller stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/http/controllers/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name).endsWith('Controller') ? pascal(name) : `${pascal(name)}Controller`
    return `import type { HttpContext } from '@strav/http'

export class ${cls} {
  async handle(ctx: HttpContext): Promise<Response> {
    return ctx.response.ok('Hello from ${cls}')
  }
}
`
  }
}
