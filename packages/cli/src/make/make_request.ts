import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeRequest extends MakeCommand {
  static signature = 'make:request {name}'
  static description = 'Create a new FormRequest stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/http/requests/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name).endsWith('Request') ? pascal(name) : `${pascal(name)}Request`
    return `import { FormRequest } from '@strav/http'
import { z } from 'zod'

export class ${cls} extends FormRequest {
  schema = z.object({
    // define your fields here
  })
}
`
  }
}
