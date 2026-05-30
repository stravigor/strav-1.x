/**
 * `DiscordNotificationDriver` — POSTs notifications to a Discord
 * webhook URL.
 *
 * The wire shape matches Discord's
 * [Execute Webhook](https://discord.com/developers/docs/resources/webhook#execute-webhook)
 * endpoint:
 *
 *   POST {webhookUrl}[?wait=true]
 *   content-type: application/json
 *
 *   {
 *     "content":  "Hi from Strav",            // ≤ 2000 chars
 *     "username": "Strav",                    // overrides webhook default
 *     "avatar_url": "https://...",
 *     "embeds":   [ { "title": "...", ... } ],
 *     "components": [ ... ],
 *     "allowed_mentions": { "parse": [] }
 *   }
 *
 * Reads `notification.toDiscord(notifiable)` for the body. The hook
 * can return either:
 *
 *   - A string — shorthand for `{ content: <string> }`.
 *   - A `DiscordMessage` — full envelope, including an optional
 *     `webhookUrl` field that overrides the channel default.
 *
 * Webhook URL resolution order: hook return → `notifiable.discordWebhookUrl`
 * → `config.webhookUrl`. When none resolve, the dispatch is skipped
 * (`{ delivered: false }` with no error) — same intentional opt-out
 * the mail + webhook channels use.
 *
 * Wire normalisation:
 *   - `username` / `avatar_url`: per-message > channel default. The
 *     hook sees the channel default as a `defaults` argument so it
 *     can branch on it if needed.
 *   - Camel-case keys on the JS side (`avatarUrl`, `allowedMentions`,
 *     `threadName`) are translated to Discord's snake_case wire form
 *     before send. This keeps apps' notification code idiomatic.
 *
 * On 2xx the driver returns `{ delivered: true }`. With `wait: true`,
 * Discord echoes the created message JSON — the driver returns its
 * `id` as the dispatch `reference`. On 4xx / 5xx / network failure
 * the driver throws `NotificationDeliveryError`; 429 + 5xx flag
 * `retryable: true`.
 */

import type { Notifiable } from '../../notifiable.ts'
import type { BaseNotification } from '../../notification.ts'
import type { NotificationDriver } from '../../notification_driver.ts'
import { NotificationDeliveryError } from '../../notification_error.ts'
import type { NotificationContext, NotificationDeliveryResult } from '../../types.ts'

/** Shape returned by `notification.toDiscord(notifiable)`. */
export interface DiscordMessage {
  /** Message text body. Up to 2000 chars (Discord limit — not enforced here). */
  content?: string
  /** Override the webhook's configured display name for this message. */
  username?: string
  /** Override the webhook's avatar for this message. */
  avatarUrl?: string
  /** Embeds — up to 10. Apps build them per the Discord embed object spec. */
  embeds?: ReadonlyArray<Record<string, unknown>>
  /** Message-component arrays (buttons, selects). */
  components?: ReadonlyArray<Record<string, unknown>>
  /**
   * Allowed-mentions control. Default behaviour at Discord is to
   * resolve every mention in `content` — set
   * `{ parse: [] }` to suppress all `@mentions`.
   */
  allowedMentions?: Record<string, unknown>
  /** Render the message as text-to-speech. */
  tts?: boolean
  /** When the webhook targets a forum, name the new thread. */
  threadName?: string
  /** Message flags bitfield (e.g. SUPPRESS_EMBEDS = 1 << 2). */
  flags?: number
  /**
   * Override the webhook URL for this dispatch only. Useful when the
   * notification carries its own routing decision; takes priority
   * over `notifiable.discordWebhookUrl` and `config.webhookUrl`.
   */
  webhookUrl?: string
  /**
   * Pass-through escape hatch — keys placed here are added to the
   * Discord payload verbatim (snake_case expected). Use for fields
   * the typed envelope hasn't grown to cover yet.
   */
  extra?: Record<string, unknown>
}

/** Hook surface — apps add `toDiscord(notifiable, defaults)` on their notification. */
interface DiscordCapableNotification extends BaseNotification {
  toDiscord?(
    notifiable: Notifiable,
    defaults: { username?: string; avatarUrl?: string },
  ): string | DiscordMessage | Promise<string | DiscordMessage>
}

interface NotifiableWithDiscordWebhook extends Notifiable {
  discordWebhookUrl?: string
}

export interface DiscordNotificationDriverOptions {
  name: string
  webhookUrl?: string
  username?: string
  avatarUrl?: string
  wait?: boolean
  timeoutMs?: number
  /** Custom `fetch` for tests. */
  fetch?: typeof fetch
}

export class DiscordNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly defaultWebhookUrl: string | undefined
  private readonly username: string | undefined
  private readonly avatarUrl: string | undefined
  private readonly wait: boolean
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(options: DiscordNotificationDriverOptions) {
    this.name = options.name
    this.defaultWebhookUrl = options.webhookUrl
    this.username = options.username
    this.avatarUrl = options.avatarUrl
    this.wait = options.wait ?? false
    this.timeoutMs = options.timeoutMs ?? 5000
    this.fetchFn = options.fetch ?? fetch
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as DiscordCapableNotification).toDiscord
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }

    const defaults = {
      ...(this.username !== undefined ? { username: this.username } : {}),
      ...(this.avatarUrl !== undefined ? { avatarUrl: this.avatarUrl } : {}),
    }
    const raw = await hook.call(notification, notifiable, defaults)
    const message: DiscordMessage = typeof raw === 'string' ? { content: raw } : raw

    const webhookUrl =
      message.webhookUrl ??
      (notifiable as NotifiableWithDiscordWebhook).discordWebhookUrl ??
      this.defaultWebhookUrl
    if (webhookUrl === undefined || webhookUrl === '') {
      return { channel: this.name, delivered: false }
    }

    const body = JSON.stringify(serialise(message, defaults))
    const endpoint = this.wait ? appendWait(webhookUrl) : webhookUrl

    let response: Response
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new NotificationDeliveryError(
        `DiscordNotificationDriver: network failure for channel "${this.name}".`,
        {
          context: {
            channel: this.name,
            notifiableId: notifiable.id,
            notification: notification.constructor.name,
            retryable: true,
          },
          cause,
        },
      )
    }

    if (response.ok) {
      // When `wait: true`, Discord returns 200 with the created message
      // JSON; we expose its id as the dispatch reference. Without
      // `wait`, Discord returns 204 — no reference available, fall
      // back to the notification context id for correlation.
      let reference: string = context.id
      if (this.wait && response.status === 200) {
        try {
          const created = (await response.json()) as { id?: string }
          if (typeof created.id === 'string') reference = created.id
        } catch {
          // Discord drifted — keep the context id as the reference.
        }
      }
      return { channel: this.name, delivered: true, reference }
    }

    const responseBody = await response.text().catch(() => '')
    throw new NotificationDeliveryError(
      `DiscordNotificationDriver: Discord responded HTTP ${response.status} ${response.statusText}.`,
      {
        context: {
          channel: this.name,
          notifiableId: notifiable.id,
          notification: notification.constructor.name,
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
          responseBody: responseBody.slice(0, 1024),
        },
      },
    )
  }
}

/**
 * Map our camel-case `DiscordMessage` shape onto Discord's wire JSON.
 * Per-message values win over channel defaults; `extra` is spread
 * verbatim so apps can reach fields the typed envelope hasn't grown
 * to yet (e.g. `poll`, `applied_tags` for forum posts).
 */
function serialise(
  m: DiscordMessage,
  defaults: { username?: string; avatarUrl?: string },
): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...m.extra }
  if (m.content !== undefined) wire.content = m.content
  const username = m.username ?? defaults.username
  if (username !== undefined) wire.username = username
  const avatar = m.avatarUrl ?? defaults.avatarUrl
  if (avatar !== undefined) wire.avatar_url = avatar
  if (m.embeds !== undefined) wire.embeds = m.embeds
  if (m.components !== undefined) wire.components = m.components
  if (m.allowedMentions !== undefined) wire.allowed_mentions = m.allowedMentions
  if (m.tts !== undefined) wire.tts = m.tts
  if (m.threadName !== undefined) wire.thread_name = m.threadName
  if (m.flags !== undefined) wire.flags = m.flags
  return wire
}

function appendWait(url: string): string {
  return url.includes('?') ? `${url}&wait=true` : `${url}?wait=true`
}
