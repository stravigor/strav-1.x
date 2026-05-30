/**
 * `LineDriver` — `InstantDriver` for the LINE Messaging API.
 *
 * Wraps `@line/bot-sdk`'s `LineBotClient` for send / reply / push
 * / multicast / broadcast / profile. Webhook signature
 * verification and event parsing live in `line_webhook.ts`; the
 * driver delegates to those.
 *
 * Capability declarations match what LINE supports natively. LIFF
 * (`liff`), Flex (`send.flex`), rich menus (`richMenu`), and
 * beacons (`beacon`) are all included — apps reach the matching
 * helpers via the subpath barrel:
 *
 *   import { LineDriver, flex, LineLiff, LineRichMenu } from '@strav/instant/line'
 */

import { LineBotClient, type messagingApi } from '@line/bot-sdk'
import { InstantProviderError } from '../errors.ts'
import type { InstantCapability } from '../instant_capabilities.ts'
import type { InstantDriver, UserProfile, WebhookOps } from '../instant_driver.ts'
import type { OutgoingMessage, SendResult } from '../message.ts'
import type { LineProviderConfig } from './line_config.ts'
import { LineLiff } from './line_liff.ts'
import { toLineMessages } from './line_message_mapper.ts'
import { LineRichMenu } from './line_rich_menu.ts'
import { parseLineWebhook, verifyLineSignature } from './line_webhook.ts'

const DEFAULT_CAPABILITIES: ReadonlySet<InstantCapability> = new Set<InstantCapability>([
  'send.text',
  'send.image',
  'send.video',
  'send.audio',
  'send.location',
  'send.sticker',
  'send.quickReplies',
  'send.flex',
  'send.template',
  'reply',
  'push',
  'multicast',
  'broadcast',
  'profile',
  'richMenu',
  'beacon',
  'liff',
  'webhook.signature',
  'webhook.parse',
])

export interface LineDriverOptions {
  instanceName: string
  config: LineProviderConfig
  /** Inject a pre-built client (tests / mocks). */
  client?: LineBotClient
}

export class LineDriver implements InstantDriver {
  readonly name = 'line'
  readonly instanceName: string
  readonly capabilities = DEFAULT_CAPABILITIES
  readonly client: LineBotClient
  readonly webhook: WebhookOps

  /** Lazy LIFF helper — constructed on first access since not every app uses LIFF. */
  private _liff: LineLiff | undefined
  /** Lazy rich-menu helper. */
  private _richMenu: LineRichMenu | undefined

  constructor(options: LineDriverOptions) {
    const { instanceName, config } = options
    if (!config.channelAccessToken) {
      throw new InstantProviderError(
        `LineDriver: \`channelAccessToken\` is required for provider "${instanceName}".`,
        { provider: 'line', operation: 'init', status: 500 },
      )
    }
    if (!config.channelSecret) {
      throw new InstantProviderError(
        `LineDriver: \`channelSecret\` is required for provider "${instanceName}".`,
        { provider: 'line', operation: 'init', status: 500 },
      )
    }
    this.instanceName = instanceName
    this.client =
      options.client ??
      LineBotClient.fromChannelAccessToken({
        channelAccessToken: config.channelAccessToken,
        ...(config.apiBaseURL ? { apiBaseURL: config.apiBaseURL } : {}),
        ...(config.dataApiBaseURL ? { dataApiBaseURL: config.dataApiBaseURL } : {}),
      })
    const channelSecret = config.channelSecret
    const liffChannelId = config.liff?.channelId
    this.webhook = {
      verifySignature: (rawBody, signature) =>
        verifyLineSignature(rawBody, signature, channelSecret),
      parse: (rawBody) => parseLineWebhook(rawBody),
    }
    if (liffChannelId) this._liff = new LineLiff(liffChannelId)
  }

  // ─── Send / push / reply / multicast / broadcast ─────────────────────

  async send(to: string, message: OutgoingMessage): Promise<SendResult> {
    return this.push(to, message)
  }

  async push(to: string, message: OutgoingMessage): Promise<SendResult> {
    return this.guard('push', async () => {
      const request: messagingApi.PushMessageRequest = {
        to,
        messages: toLineMessages(message),
      }
      const response = await this.client.pushMessage(request)
      return {
        provider: 'line',
        accepted: true,
        ...((response as { sentMessages?: Array<{ id?: string }> })?.sentMessages?.[0]?.id
          ? {
              messageId: (response as { sentMessages: Array<{ id?: string }> }).sentMessages[0]!.id,
            }
          : {}),
        raw: response,
      }
    })
  }

  async reply(replyToken: string, message: OutgoingMessage): Promise<SendResult> {
    return this.guard('reply', async () => {
      const request: messagingApi.ReplyMessageRequest = {
        replyToken,
        messages: toLineMessages(message),
      }
      const response = await this.client.replyMessage(request)
      return { provider: 'line', accepted: true, raw: response }
    })
  }

  async multicast(to: readonly string[], message: OutgoingMessage): Promise<SendResult> {
    return this.guard('multicast', async () => {
      const request: messagingApi.MulticastRequest = {
        to: [...to],
        messages: toLineMessages(message),
      }
      const response = await this.client.multicast(request)
      return { provider: 'line', accepted: true, raw: response }
    })
  }

  async broadcast(message: OutgoingMessage): Promise<SendResult> {
    return this.guard('broadcast', async () => {
      const request: messagingApi.BroadcastRequest = {
        messages: toLineMessages(message),
      }
      const response = await this.client.broadcast(request)
      return { provider: 'line', accepted: true, raw: response }
    })
  }

  async profile(userId: string): Promise<UserProfile> {
    return this.guard('profile', async () => {
      const r = await this.client.getProfile(userId)
      return {
        userId: r.userId,
        ...(r.displayName ? { displayName: r.displayName } : {}),
        ...(r.pictureUrl ? { pictureUrl: r.pictureUrl } : {}),
        ...(r.statusMessage ? { statusMessage: r.statusMessage } : {}),
        ...(r.language ? { language: r.language } : {}),
        raw: r,
      }
    })
  }

  // ─── LINE-specific surfaces ──────────────────────────────────────────

  get liff(): LineLiff {
    if (!this._liff) {
      throw new InstantProviderError(
        'LineDriver: `liff.channelId` is not configured — set `config.liff.channelId` to the LINE Login channel id that hosts the LIFF app (NOT the Messaging API channel id).',
        { provider: 'line', operation: 'liff', status: 500 },
      )
    }
    return this._liff
  }

  get richMenu(): LineRichMenu {
    if (!this._richMenu) this._richMenu = new LineRichMenu(this.client)
    return this._richMenu
  }

  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (cause) {
      if (cause instanceof InstantProviderError) throw cause
      throw new InstantProviderError(`LINE \`${operation}\` failed.`, {
        provider: 'line',
        operation,
        cause,
      })
    }
  }
}
