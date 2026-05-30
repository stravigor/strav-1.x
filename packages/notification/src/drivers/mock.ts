/**
 * In-memory notification recorder for tests. Captures every
 * `(notifiable, notification, context)` triple and reports them
 * as delivered. Apps under test assert on the recorded array.
 *
 * Pairs with `@strav/testing`-style flows: register via
 * `manager.useDriver('test', new MockNotificationDriver())` after
 * boot, send notifications, inspect `driver.records`.
 */

import type { Notifiable } from '../notifiable.ts'
import type { BaseNotification } from '../notification.ts'
import type { NotificationDriver, NotificationDriverFactory } from '../notification_driver.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../types.ts'

export interface MockNotificationRecord {
  notifiable: Notifiable
  notification: BaseNotification
  context: NotificationContext
}

export class MockNotificationDriver implements NotificationDriver {
  readonly records: MockNotificationRecord[] = []

  constructor(public readonly name = 'mock') {}

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    this.records.push({ notifiable, notification, context })
    return { channel: this.name, delivered: true, reference: context.id }
  }

  /** Drop everything recorded so far. Useful between assertions. */
  clear(): void {
    this.records.length = 0
  }
}

/**
 * Factory shape so apps can register `driver: 'mock'` in config and
 * get a fresh instance per channel. Defaults the channel name to the
 * configured key (matches other channel factories).
 */
export const mockNotificationDriverFactory: NotificationDriverFactory = ({ instanceName }) =>
  new MockNotificationDriver(instanceName)
