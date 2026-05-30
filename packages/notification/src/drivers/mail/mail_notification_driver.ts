/**
 * `MailNotificationDriver` — fans a notification into the configured
 * `MailManager`. Reads `notification.toMail(notifiable)` for the
 * message body; skips delivery (returns `{ delivered: false }` with
 * no error) when the hook is absent — the channel chooses not to
 * service notifications that don't model themselves as mail.
 *
 * Depends on `@strav/mail` (peer, optional on `@strav/notification`).
 * Apps that want this driver register `MailNotificationProvider` AND
 * have `MailProvider` + `MailManager` already in the container.
 */

import type { MailManager, Message } from '@strav/mail'
import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import { NotificationDeliveryError } from '../../notification_error.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'

/** Optional hook surface — apps add `toMail(notifiable)` on their notification. */
interface MailCapableNotification extends BaseNotification {
  toMail?(notifiable: Notifiable): Message | Promise<Message>
}

export interface MailNotificationDriverOptions {
  name: string
  mail: MailManager
}

export class MailNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly mail: MailManager

  constructor(options: MailNotificationDriverOptions) {
    this.name = options.name
    this.mail = options.mail
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as MailCapableNotification).toMail
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }
    try {
      const message = await hook.call(notification, notifiable)
      await this.mail.send(message)
      return { channel: this.name, delivered: true, reference: context.id }
    } catch (cause) {
      throw new NotificationDeliveryError(
        `MailNotificationDriver: send failed for channel "${this.name}".`,
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
