/**
 * `LogNotificationDriver` — writes notification records to the
 * configured `Logger` channel. Useful for dev-mode + smoke tests
 * where the cost of a real channel (mail, push, broadcast) isn't
 * warranted.
 *
 * Reads `notification.toLog(notifiable)` to get the message body
 * — apps' `BaseNotification` subclass implements that. When the
 * hook is absent, the driver logs a minimal `{ type, id }` line
 * so devs still see something fire without forcing every
 * notification to define `toLog`.
 *
 * No external deps beyond `@strav/kernel`.
 */

import type { Logger } from '@strav/kernel'
import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'

/** Optional hook surface — apps add `toLog(notifiable)` to their notification. */
interface LogCapableNotification extends BaseNotification {
  toLog?(notifiable: Notifiable): string | Record<string, unknown>
}

export interface LogNotificationDriverOptions {
  /** Channel name surfaced as `driver.name`. Defaults to the manager-bound instance name. */
  name: string
  logger: Logger
  /** Log level. Default `'info'`. */
  level?: 'info' | 'warn' | 'error'
}

export class LogNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly logger: Logger
  private readonly level: 'info' | 'warn' | 'error'

  constructor(options: LogNotificationDriverOptions) {
    this.name = options.name
    this.logger = options.logger
    this.level = options.level ?? 'info'
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as LogCapableNotification).toLog
    const payload = typeof hook === 'function' ? hook.call(notification, notifiable) : undefined

    const fields: Record<string, unknown> = {
      'notification.id': context.id,
      'notification.type': notification.constructor.name,
      'notification.channel': this.name,
      'notifiable.id': notifiable.id,
    }
    if (typeof payload === 'string') {
      this.logger[this.level](payload, fields)
    } else if (payload !== undefined) {
      this.logger[this.level](`${notification.constructor.name} dispatched to ${this.name}`, {
        ...fields,
        ...payload,
      })
    } else {
      this.logger[this.level](`${notification.constructor.name} dispatched to ${this.name}`, fields)
    }
    return { channel: this.name, delivered: true, reference: context.id }
  }
}
