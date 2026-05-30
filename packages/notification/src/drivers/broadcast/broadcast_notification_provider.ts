import { Broadcaster } from '@strav/broadcast'
import { type Application, ServiceProvider } from '@strav/kernel'
import { NotificationManager } from '../../notification_manager.ts'
import { BroadcastNotificationDriver } from './broadcast_notification_driver.ts'

export class BroadcastNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.broadcast'
  override readonly dependencies = ['notification', 'broadcast']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    const broadcaster = app.resolve(Broadcaster)
    manager.extend(
      'broadcast',
      ({ instanceName }) => new BroadcastNotificationDriver({ name: instanceName, broadcaster }),
    )
  }
}
