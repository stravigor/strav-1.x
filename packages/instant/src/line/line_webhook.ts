/**
 * LINE webhook helpers — signature verification + event parsing
 * into the framework's normalized `WebhookEvent` union.
 *
 * Signature verification uses `@line/bot-sdk`'s `validateSignature`
 * (HMAC-SHA256 of the raw body against the channel secret,
 * base64-encoded, constant-time compared against the
 * `x-line-signature` header).
 *
 * Parsing turns each `events[]` entry from the LINE callback body
 * into one normalized `WebhookEvent`. Variants the framework
 * doesn't model (membership, video play complete, module attach,
 * etc.) map to `{ type: 'unknown', raw }` so apps that want them
 * can still reach the original payload via `event.raw`.
 */

import { type webhook as lineWebhook, validateSignature } from '@line/bot-sdk'
import type {
  BeaconEvent,
  FollowEvent,
  JoinEvent,
  LocationMessageEvent,
  MediaMessageEvent,
  PostbackEvent,
  StickerMessageEvent,
  TextMessageEvent,
  UnknownEvent,
  WebhookEvent,
  WebhookEventBase,
} from '../webhook_event.ts'

type LineSource = lineWebhook.Source
type LineEvent = lineWebhook.Event

export function verifyLineSignature(
  rawBody: string,
  signature: string | null | undefined,
  channelSecret: string,
): boolean {
  if (!signature) return false
  try {
    return validateSignature(rawBody, channelSecret, signature)
  } catch {
    return false
  }
}

export function parseLineWebhook(rawBody: string): WebhookEvent[] {
  const callback = JSON.parse(rawBody) as lineWebhook.CallbackRequest
  if (!callback?.events || !Array.isArray(callback.events)) return []
  return callback.events.map(toWebhookEvent)
}

function toWebhookEvent(event: LineEvent): WebhookEvent {
  const base = buildBase(event)

  switch (event.type) {
    case 'message': {
      const message = event.message
      switch (message.type) {
        case 'text':
          return {
            ...base,
            type: 'message.text',
            messageId: message.id,
            text: message.text,
          } satisfies TextMessageEvent
        case 'image':
        case 'video':
        case 'audio':
        case 'file': {
          const media: MediaMessageEvent = {
            ...base,
            type: `message.${message.type}` as MediaMessageEvent['type'],
            messageId: message.id,
          }
          return media
        }
        case 'location':
          return {
            ...base,
            type: 'message.location',
            messageId: message.id,
            latitude: message.latitude,
            longitude: message.longitude,
            ...(message.title ? { title: message.title } : {}),
            ...(message.address ? { address: message.address } : {}),
          } satisfies LocationMessageEvent
        case 'sticker':
          return {
            ...base,
            type: 'message.sticker',
            messageId: message.id,
            packageId: message.packageId,
            stickerId: message.stickerId,
          } satisfies StickerMessageEvent
        default:
          return { ...base, type: 'unknown' } satisfies UnknownEvent
      }
    }
    case 'postback':
      return {
        ...base,
        type: 'postback',
        data: event.postback.data,
      } satisfies PostbackEvent
    case 'follow':
      return { ...base, type: 'follow' } satisfies FollowEvent
    case 'unfollow':
      return { ...base, type: 'unfollow' } satisfies FollowEvent
    case 'join':
      return { ...base, type: 'join' } satisfies JoinEvent
    case 'leave':
      return { ...base, type: 'leave' } satisfies JoinEvent
    case 'beacon':
      return {
        ...base,
        type: 'beacon',
        beacon: {
          hwid: event.beacon.hwid,
          kind: event.beacon.type as BeaconEvent['beacon']['kind'],
          ...(event.beacon.dm ? { dm: event.beacon.dm } : {}),
        },
      } satisfies BeaconEvent
    default:
      return { ...base, type: 'unknown' } satisfies UnknownEvent
  }
}

function buildBase(event: LineEvent): WebhookEventBase {
  const { userId, kind, sourceId } = readSource(event.source)
  const replyToken = (event as { replyToken?: string }).replyToken
  return {
    provider: 'line',
    userId,
    timestamp: new Date(event.timestamp),
    source: kind,
    ...(sourceId ? { sourceId } : {}),
    ...(replyToken ? { replyToken } : {}),
    raw: event,
  }
}

function readSource(source: LineSource | undefined): {
  userId: string
  kind: WebhookEventBase['source']
  sourceId?: string
} {
  if (!source) return { userId: '', kind: 'unknown' }
  switch (source.type) {
    case 'user':
      return { userId: source.userId ?? '', kind: 'user' }
    case 'group':
      return {
        userId: source.userId ?? '',
        kind: 'group',
        sourceId: source.groupId,
      }
    case 'room':
      return {
        userId: source.userId ?? '',
        kind: 'room',
        sourceId: source.roomId,
      }
    default:
      return { userId: '', kind: 'unknown' }
  }
}
