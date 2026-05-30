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
    return `import { BaseNotification, type Notifiable } from '@strav/notification'
import { type Message } from '@strav/mail'

export class ${cls} extends BaseNotification {
  override via(_notifiable: Notifiable): readonly string[] {
    return ['mail']
  }

  override toMail(_notifiable: Notifiable): Message {
    return {
      to: [],
      subject: '${cls}',
      text: 'Edit packages/.../notifications/${snake(name)}.ts',
    }
  }
}
`
  }
}
