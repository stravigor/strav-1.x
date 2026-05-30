/**
 * `WebhookEvent` — the normalized inbound event union the manager
 * exposes to apps. Drivers convert their provider-native event
 * shape (LINE event, WhatsApp change, Messenger entry) into one
 * of these variants. Events the driver can't normalize map to
 * `unknown` and surface via `raw` so apps that opt into raw
 * handling don't lose anything.
 *
 * Every variant carries `provider`, `userId` (the opaque
 * recipient identifier — LINE `userId`, WhatsApp phone, Messenger
 * PSID), `timestamp`, and `raw` so apps can drop down when the
 * normalized shape isn't enough.
 */

export interface WebhookEventBase {
  /** Driver name. */
  provider: string
  /** Opaque user identifier from the provider. */
  userId: string
  /** Provider-issued event timestamp (Date). */
  timestamp: Date
  /** Conversation source — direct chat (`user`), group (`group`), room (`room`), etc. */
  source: 'user' | 'group' | 'room' | 'unknown'
  /** Group / room id when `source !== 'user'`. */
  sourceId?: string
  /** Reply token (LINE) or message context for short-lived reply windows. */
  replyToken?: string
  /** Provider-native event payload. */
  raw: unknown
}

export interface TextMessageEvent extends WebhookEventBase {
  type: 'message.text'
  text: string
  /** Provider-issued message id. */
  messageId: string
}

export interface MediaMessageEvent extends WebhookEventBase {
  type: 'message.image' | 'message.video' | 'message.audio' | 'message.file'
  messageId: string
  /** When the provider hands back content directly (vs. needing a fetch). */
  contentUrl?: string
}

export interface LocationMessageEvent extends WebhookEventBase {
  type: 'message.location'
  messageId: string
  latitude: number
  longitude: number
  title?: string
  address?: string
}

export interface StickerMessageEvent extends WebhookEventBase {
  type: 'message.sticker'
  messageId: string
  packageId?: string
  stickerId?: string
}

export interface PostbackEvent extends WebhookEventBase {
  type: 'postback'
  data: string
}

export interface FollowEvent extends WebhookEventBase {
  type: 'follow' | 'unfollow'
}

export interface JoinEvent extends WebhookEventBase {
  type: 'join' | 'leave'
}

export interface BeaconEvent extends WebhookEventBase {
  type: 'beacon'
  beacon: { hwid: string; kind: 'enter' | 'banner' | 'stay'; dm?: string }
}

export interface UnknownEvent extends WebhookEventBase {
  type: 'unknown'
}

export type WebhookEvent =
  | TextMessageEvent
  | MediaMessageEvent
  | LocationMessageEvent
  | StickerMessageEvent
  | PostbackEvent
  | FollowEvent
  | JoinEvent
  | BeaconEvent
  | UnknownEvent
