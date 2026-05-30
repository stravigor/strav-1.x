import { type Application, ServiceProvider } from '@strav/kernel'
import { MailManager } from '@strav/mail'
import { NotificationManager } from '../../notification_manager.ts'
import { MailNotificationDriver } from './mail_notification_driver.ts'

export class MailNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.mail'
  override readonly dependencies = ['notification', 'mail']

  override async boot(app: Application): Promise<void> {
    const notifications = app.resolve(NotificationManager)
    const mail = app.resolve(MailManager)
    notifications.extend(
      'mail',
      ({ instanceName }) => new MailNotificationDriver({ name: instanceName, mail }),
    )
  }
}
