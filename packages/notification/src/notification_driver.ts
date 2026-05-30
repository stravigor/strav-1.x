/**
 * `NotificationDriver` — the contract every channel implements.
 *
 * One driver instance per configured channel. The manager calls
 * `send(notifiable, notification, context)` once per channel that
 * `notification.via(notifiable)` named; drivers either deliver or
 * return `{ delivered: false, error }`.
 *
 * Drivers MAY ignore notifications they can't service (no
 * `to<Channel>` hook, recipient missing channel-required fields) by
 * returning `{ delivered: false }` with no `error` — the manager
 * surfaces this in the dispatch result without treating it as a
 * failure.
 */

import type { Notifiable } from './notifiable.ts'
import type { BaseNotification } from './notification.ts'
import type { NotificationContext, NotificationDeliveryResult } from './types.ts'

export interface NotificationDriver {
  /** Identifier — matches `config.notification.channels` key. */
  readonly name: string

  send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult>
}

/**
 * Channel factory — apps register custom channels via
 * `manager.extend(name, factory)`. The factory receives the channel's
 * config sub-tree plus an `instanceName` (the key under
 * `config.notification.channels`).
 */
export type NotificationDriverFactory = (args: {
  instanceName: string
  config: { driver: string; [key: string]: unknown }
}) => NotificationDriver
