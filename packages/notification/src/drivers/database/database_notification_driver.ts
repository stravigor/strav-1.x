/**
 * `DatabaseNotificationDriver` — persists every dispatched notification
 * into the `notification` ledger via `NotificationRepository.record`.
 *
 * Reads `notification.toDatabase(notifiable)` for the per-notification
 * payload. When the hook is absent, the driver returns
 * `{ delivered: false }` with no error — the channel chooses not to
 * service notifications that don't model themselves as persistable.
 *
 * Tenanted variant uses `TenantedNotificationRepository` from
 * `@strav/notification/tenanted` — the wiring is identical apart
 * from the repository class.
 */

import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import { NotificationDeliveryError } from '../../notification_error.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'
import type { NotificationRepository } from './notification_repository.ts'

interface PersistableNotification extends BaseNotification {
  toDatabase?(notifiable: Notifiable): Record<string, unknown> | Promise<Record<string, unknown>>
}

export interface DatabaseNotificationDriverOptions {
  name: string
  repository: NotificationRepository
}

export class DatabaseNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly repository: NotificationRepository

  constructor(options: DatabaseNotificationDriverOptions) {
    this.name = options.name
    this.repository = options.repository
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as PersistableNotification).toDatabase
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }
    try {
      const data = await hook.call(notification, notifiable)
      const record = await this.repository.record({
        id: context.id,
        notifiable,
        type: notification.constructor.name,
        data,
      })
      return { channel: this.name, delivered: true, reference: record.id }
    } catch (cause) {
      throw new NotificationDeliveryError(
        `DatabaseNotificationDriver: persist failed for channel "${this.name}".`,
        {
          context: {
            channel: this.name,
            notifiableId: notifiable.id,
            notification: notification.constructor.name,
          },
          cause,
        },
      )
    }
  }
}
