import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeMiddleware extends MakeCommand {
  static signature = 'make:middleware {name}'
  static description = 'Create a new HTTP middleware stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/http/middleware/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name)
    return `import type { HttpContext, MiddlewareNext } from '@strav/http'

export class ${cls} {
  async handle(ctx: HttpContext, next: MiddlewareNext): Promise<Response> {
    return next(ctx)
  }
}
`
  }
}
