/**
 * `BroadcastNotificationDriver` — fans a notification onto the
 * configured `Broadcaster`. Reads
 * `notification.toBroadcast(notifiable): BroadcastNotificationPayload`
 * for the channel routing + event body.
 *
 * Skips delivery (returns `{ delivered: false }` without throwing) when
 * the hook is absent — same opt-out semantics as the mail / webhook
 * drivers.
 *
 * Depends on `@strav/broadcast` (peer, optional on `@strav/notification`).
 * Apps that want this driver register `BroadcastNotificationProvider`
 * AND have a `BroadcastProvider` (or `PostgresBroadcastProvider`)
 * binding `Broadcaster` in the container.
 */

import type { Broadcaster } from '@strav/broadcast'
import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import { NotificationDeliveryError } from '../../notification_error.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'

/**
 * What `toBroadcast(notifiable)` returns. `channel` is the target
 * pub/sub channel name; `event` defaults to the notification class
 * name when omitted; `data` is the JSON-serialisable payload.
 */
export interface BroadcastNotificationPayload {
  channel: string
  event?: string
  data: unknown
}

interface BroadcastCapableNotification extends BaseNotification {
  toBroadcast?(
    notifiable: Notifiable,
  ): BroadcastNotificationPayload | Promise<BroadcastNotificationPayload>
}

export interface BroadcastNotificationDriverOptions {
  name: string
  broadcaster: Broadcaster
}

export class BroadcastNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly broadcaster: Broadcaster

  constructor(options: BroadcastNotificationDriverOptions) {
    this.name = options.name
    this.broadcaster = options.broadcaster
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as BroadcastCapableNotification).toBroadcast
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }

    let payload: BroadcastNotificationPayload
    try {
      payload = await hook.call(notification, notifiable)
    } catch (cause) {
      throw new NotificationDeliveryError(
        `BroadcastNotificationDriver: toBroadcast() threw for channel "${this.name}".`,
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

    try {
      await this.broadcaster.publish(payload.channel, {
        id: context.id,
        event: payload.event ?? notification.constructor.name,
        data: payload.data,
      })
    } catch (cause) {
      throw new NotificationDeliveryError(
        `BroadcastNotificationDriver: publish failed on broadcast channel "${payload.channel}".`,
        {
          context: {
            channel: this.name,
            broadcastChannel: payload.channel,
            notifiableId: notifiable.id,
            notification: notification.constructor.name,
          },
          cause,
        },
      )
    }

    return { channel: this.name, delivered: true, reference: context.id }
  }
}
