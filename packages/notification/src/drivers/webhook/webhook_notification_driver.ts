/**
 * `WebhookNotificationDriver` — POSTs notifications to a configured
 * HTTPS endpoint, HMAC-signed.
 *
 * The wire shape:
 *
 *   POST {endpoint}
 *   content-type: application/json
 *   x-strav-notification-id: 01J...                ← ULID, matches NotificationContext.id
 *   x-strav-notification-type: InvoicePaid         ← notification subclass name
 *   x-strav-timestamp: 1737000000                  ← unix seconds at send time
 *   x-strav-signature: sha256=ab12...              ← HMAC over `${timestamp}.${body}`
 *   [...configured headers...]
 *
 *   {
 *     "notification": { "id": "01J...", "type": "InvoicePaid",
 *                       "dispatchedAt": "2026-05-30T08:30:00.000Z" },
 *     "notifiable":    { "id": "u_1", "type": "User" },
 *     "data":          { ...whatever toWebhook returned... }
 *   }
 *
 * Verification on the receiver:
 *
 *   import { verifyWebhookSignature } from '@strav/notification/webhook'
 *   const [algo, sig] = req.headers['x-strav-signature'].split('=')
 *   if (!verifyWebhookSignature(algo, SECRET, req.headers['x-strav-timestamp'],
 *                               rawBody, sig)) return 401
 *   if (Math.abs(now - Number(req.headers['x-strav-timestamp'])) > 300) return 401
 *
 * Reads `notification.toWebhook(notifiable)` for the body data. Skips
 * delivery (returns `{ delivered: false }` with no error) when the hook
 * is absent — channel-level opt-out is intentional, same as the mail
 * driver. Throws `NotificationDeliveryError` on non-2xx, network
 * failure, or timeout — the manager captures it into the dispatch
 * result without rethrowing.
 *
 * No external deps. Stays pure-fetch; the only Node-stdlib reach is
 * `node:crypto` for HMAC.
 */

import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import { NotificationDeliveryError } from '../../notification_error.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'
import { signWebhook } from './sign.ts'
import type { WebhookSignatureAlgorithm } from './webhook_config.ts'

/** Optional hook surface — apps add `toWebhook(notifiable)` on their notification. */
interface WebhookCapableNotification extends BaseNotification {
  toWebhook?(notifiable: Notifiable): unknown | Promise<unknown>
}

export interface WebhookNotificationDriverOptions {
  name: string
  endpoint: string
  secret: string
  algorithm?: WebhookSignatureAlgorithm
  headers?: Record<string, string>
  timeoutMs?: number
  /** Custom `fetch` for tests. */
  fetch?: typeof fetch
  /** Override clock for deterministic signatures in tests. */
  now?: () => Date
}

export class WebhookNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly endpoint: string
  private readonly secret: string
  private readonly algorithm: WebhookSignatureAlgorithm
  private readonly extraHeaders: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly nowFn: () => Date

  constructor(options: WebhookNotificationDriverOptions) {
    this.name = options.name
    this.endpoint = options.endpoint
    this.secret = options.secret
    this.algorithm = options.algorithm ?? 'sha256'
    this.extraHeaders = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 5000
    this.fetchFn = options.fetch ?? fetch
    this.nowFn = options.now ?? (() => new Date())
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as WebhookCapableNotification).toWebhook
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }

    const data = await hook.call(notification, notifiable)
    const envelope = {
      notification: {
        id: context.id,
        type: notification.constructor.name,
        dispatchedAt: context.dispatchedAt.toISOString(),
      },
      notifiable: {
        id: notifiable.id,
        ...(notifiable.notifiableType !== undefined ? { type: notifiable.notifiableType } : {}),
      },
      data,
    }

    const body = JSON.stringify(envelope)
    const timestamp = Math.floor(this.nowFn().getTime() / 1000).toString()
    const signature = signWebhook(this.algorithm, this.secret, timestamp, body)

    const headers: Record<string, string> = {
      ...this.extraHeaders,
      'content-type': 'application/json',
      'x-strav-notification-id': context.id,
      'x-strav-notification-type': notification.constructor.name,
      'x-strav-timestamp': timestamp,
      'x-strav-signature': `${this.algorithm}=${signature}`,
    }

    let response: Response
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new NotificationDeliveryError(
        `WebhookNotificationDriver: network failure for channel "${this.name}".`,
        {
          context: {
            channel: this.name,
            endpoint: this.endpoint,
            notifiableId: notifiable.id,
            notification: notification.constructor.name,
            retryable: true,
          },
          cause,
        },
      )
    }

    if (response.ok) {
      return { channel: this.name, delivered: true, reference: context.id }
    }

    // Best-effort capture of the response body for diagnostics — truncated
    // so a 50MB HTML error page from a misconfigured reverse proxy doesn't
    // bloat log records.
    const responseBody = await response.text().catch(() => '')
    throw new NotificationDeliveryError(
      `WebhookNotificationDriver: endpoint responded HTTP ${response.status} ${response.statusText}.`,
      {
        context: {
          channel: this.name,
          endpoint: this.endpoint,
          notifiableId: notifiable.id,
          notification: notification.constructor.name,
          status: response.status,
          retryable: response.status >= 500 || response.status === 408 || response.status === 429,
          responseBody: responseBody.slice(0, 1024),
        },
      },
    )
  }
}
