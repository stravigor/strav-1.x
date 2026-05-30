/**
 * `SSENotificationDriver` — in-process pub/sub channel for live
 * notifications.
 *
 * The driver maintains a `Map<key, Set<Subscriber>>` keyed by the
 * notifiable's identity. `send(notifiable, ...)` reads
 * `notification.toSSE(notifiable)` for the event body and pushes it
 * to every subscriber for that notifiable; HTTP handlers consume
 * subscriptions via `subscribe(id, { notifiableType? })` and pipe the
 * iterable into `sseResponse(...)` from `@strav/http`.
 *
 *   const route = router.get('/notifications/stream', async (ctx) => {
 *     const user = ctx.auth.user!
 *     const driver = notifications.use('sse') as SSENotificationDriver
 *     const stream = driver.subscribe(user.id, { notifiableType: 'User' })
 *     return sseResponse(stream, { signal: ctx.request.raw.signal })
 *   })
 *
 * Why this exists alongside the broadcast channel:
 *
 *   - **Broadcast** (`./broadcast`) routes through `@strav/broadcast`'s
 *     `Broadcaster` — pluggable backplane (memory / postgres), supports
 *     multi-process fan-out via LISTEN/NOTIFY.
 *   - **SSE** (this driver) is a single-process registry with no
 *     peer dependency. Right answer for the common "I just want my
 *     user to see the notification in their open tab" case without
 *     pulling in a broadcast driver.
 *
 * Backpressure — each subscriber holds a bounded queue (default 64).
 * When a slow consumer falls behind, the oldest events are dropped
 * to make room (and `droppedEvents` increments). Lost events are
 * the SSE contract anyway: clients recover by reading
 * `Last-Event-ID` on reconnect and asking the app to backfill from
 * the database channel.
 *
 * Skips delivery (`{ delivered: false }`, no error) when the hook is
 * absent OR no subscribers exist for the notifiable. Apps inspect
 * `result.delivered === false && result.error === undefined` to
 * branch on "user is offline" vs a real failure.
 */

import type { SSEEvent } from '@strav/http'
import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import { NotificationDeliveryError } from '../../notification_error.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'

/** Hook surface — apps add `toSSE(notifiable)` on their notification. */
interface SSECapableNotification extends BaseNotification {
  toSSE?(notifiable: Notifiable): SSEEvent | string | Promise<SSEEvent | string>
}

export interface SSESubscribeOptions {
  /**
   * Constrain the subscription to a specific notifiable type. When
   * both subscriber and dispatch provide a `notifiableType`, they
   * must match for the event to land. When either omits it, the id
   * alone is used (looser routing — useful for tests).
   */
  notifiableType?: string
}

export interface SSENotificationDriverOptions {
  name: string
  /** Per-subscriber bounded queue size. Default 64. */
  queueSize?: number
}

interface Subscriber {
  push(event: SSEEvent): void
  close(): void
  droppedEvents: number
}

export class SSENotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly queueSize: number
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  constructor(options: SSENotificationDriverOptions) {
    this.name = options.name
    this.queueSize = options.queueSize ?? 64
  }

  /**
   * Open a subscription for `id` (+ optional `notifiableType`). The
   * returned iterable yields one `SSEEvent` per matched dispatch and
   * runs cleanly when the consumer breaks out of the `for await`
   * loop or the iterator's `return()` is called (which
   * `sseResponse()` does on client disconnect).
   */
  subscribe(id: string | number, options: SSESubscribeOptions = {}): AsyncIterable<SSEEvent> {
    const key = subscriberKey(id, options.notifiableType)
    return makeSubscription(this.subscribers, key, this.queueSize)
  }

  /**
   * How many active subscribers exist for `(id, notifiableType?)`.
   * Useful for the database channel pairing — apps may want to skip
   * persisting a "live" event when the user already has an SSE tab
   * open and consumed it.
   */
  subscriberCount(id: string | number, options: SSESubscribeOptions = {}): number {
    const key = subscriberKey(id, options.notifiableType)
    return this.subscribers.get(key)?.size ?? 0
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as SSECapableNotification).toSSE
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }

    const key = subscriberKey(notifiable.id, notifiable.notifiableType)
    const targets = this.subscribers.get(key)
    if (targets === undefined || targets.size === 0) {
      return { channel: this.name, delivered: false }
    }

    let raw: SSEEvent | string
    try {
      raw = await hook.call(notification, notifiable)
    } catch (cause) {
      throw new NotificationDeliveryError(
        `SSENotificationDriver: toSSE() threw for channel "${this.name}".`,
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

    // Default `event` to the notification class and `id` to the
    // dispatch context id — both can be overridden by the hook.
    const base: SSEEvent = typeof raw === 'string' ? { data: raw } : { ...raw }
    if (base.id === undefined) base.id = context.id
    if (base.event === undefined) base.event = notification.constructor.name

    // Snapshot the subscriber set before iterating — handlers may
    // close + remove themselves mid-broadcast (e.g. heartbeat detects
    // a dead connection).
    for (const sub of Array.from(targets)) sub.push(base)

    return { channel: this.name, delivered: true, reference: context.id }
  }
}

function subscriberKey(id: string | number, notifiableType: string | undefined): string {
  return `${notifiableType ?? ''}|${id}`
}

/**
 * One subscriber = one bounded queue + a wake/sleep gate. The
 * generator's `finally` block deregisters the subscriber from the
 * shared map — so closing the response (or breaking the loop) tears
 * down the slot cleanly.
 */
function makeSubscription(
  registry: Map<string, Set<Subscriber>>,
  key: string,
  capacity: number,
): AsyncIterable<SSEEvent> {
  return {
    [Symbol.asyncIterator]() {
      const queue: SSEEvent[] = []
      let closed = false
      let waker: (() => void) | undefined
      const subscriber: Subscriber = {
        droppedEvents: 0,
        push(event) {
          if (closed) return
          if (queue.length >= capacity) {
            queue.shift()
            subscriber.droppedEvents += 1
          }
          queue.push(event)
          waker?.()
        },
        close() {
          if (closed) return
          closed = true
          waker?.()
        },
      }

      let bucket = registry.get(key)
      if (bucket === undefined) {
        bucket = new Set()
        registry.set(key, bucket)
      }
      bucket.add(subscriber)

      const detach = (): void => {
        subscriber.close()
        const set = registry.get(key)
        if (set !== undefined) {
          set.delete(subscriber)
          if (set.size === 0) registry.delete(key)
        }
      }

      return {
        async next(): Promise<IteratorResult<SSEEvent>> {
          while (true) {
            const event = queue.shift()
            if (event !== undefined) return { value: event, done: false }
            if (closed) return { value: undefined, done: true }
            await new Promise<void>((resolve) => {
              waker = resolve
            })
            waker = undefined
          }
        },
        async return(): Promise<IteratorResult<SSEEvent>> {
          detach()
          return { value: undefined, done: true }
        },
        async throw(err): Promise<IteratorResult<SSEEvent>> {
          detach()
          throw err
        },
      }
    },
  }
}
