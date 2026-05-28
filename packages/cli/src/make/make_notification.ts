import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeNotification extends MakeCommand {
  static signature = 'make:notification {name}'
  static description = 'Create a Notification stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/notifications/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name)
    return `// ${cls} notification
// Implement channels (mail, database, broadcast) once @strav/signal notifications land.
export class ${cls} {
  via(): string[] {
    return ['mail']
  }
}
`
  }
}
