import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeMail extends MakeCommand {
  static signature = 'make:mail {name}'
  static description = 'Create a Mailable stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/mail/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name)
    return `import { Mailable, type Message } from '@strav/signal'

export class ${cls} extends Mailable<unknown> {
  build(payload: unknown): Message {
    return {
      to: [{ address: 'recipient@example.com' }],
      subject: '${pascal(name)}',
      html: '<p>Hello</p>',
    }
  }
}
`
  }
}
