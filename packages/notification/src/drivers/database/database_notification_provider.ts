/**
 * ServiceProvider that registers the database-channel factory on the
 * `NotificationManager` and the `NotificationRepository` as a
 * container singleton.
 *
 * Apps include this AFTER `NotificationProvider` + `DatabaseProvider`.
 * The factory reads each channel's `tenanted` flag at construction
 * time — but the tenanted-repository wiring is the app's job
 * (apps that want it import from `@strav/notification/tenanted` and
 * register the tenanted-repository binding themselves, same pattern
 * as `@strav/social/tenanted`).
 */

import { PostgresDatabase, SchemaRegistry } from '@strav/database'
import { type Application, EventBus, ServiceProvider } from '@strav/kernel'
import { NotificationManager } from '../../notification_manager.ts'
import { DatabaseNotificationDriver } from './database_notification_driver.ts'
import { NotificationRepository } from './notification_repository.ts'

export class DatabaseNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.database'
  override readonly dependencies = ['notification', 'database']

  override register(app: Application): void {
    app.singleton(
      NotificationRepository,
      (c) =>
        new NotificationRepository({
          db: c.resolve(PostgresDatabase),
          events: c.resolve(EventBus),
          registry: c.resolve(SchemaRegistry),
        }),
    )
  }

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    const repository = app.resolve(NotificationRepository)
    manager.extend(
      'database',
      ({ instanceName }) => new DatabaseNotificationDriver({ name: instanceName, repository }),
    )
  }
}
