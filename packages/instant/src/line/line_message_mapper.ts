/**
 * Map the framework's LCD `OutgoingMessage` shape onto LINE's
 * `Message` JSON.
 *
 * LINE accepts 1-5 `Message` objects per push / reply / multicast
 * call; the mapper expands a single `OutgoingMessage` into the
 * matching number of LINE messages: one for text, one per
 * attachment, plus quick replies attached to the LAST message
 * (LINE only honours `quickReply` on the last item of a batch).
 *
 * `raw` is a passthrough — apps that need a shape outside the LCD
 * (Flex bubbles built by `flex.*`, template messages, imagemaps)
 * set `message.raw` to the LINE JSON and it goes through verbatim.
 * When `raw` is set, the LCD fields are ignored.
 */

import type { messagingApi } from '@line/bot-sdk'
import { InstantProviderError } from '../errors.ts'
import type { Attachment, OutgoingMessage, QuickReply } from '../message.ts'

type LineMessage = messagingApi.Message
type LineQuickReply = messagingApi.QuickReply
type LineAction = messagingApi.Action

export function toLineMessages(message: OutgoingMessage): LineMessage[] {
  if (message.raw !== undefined) {
    const raw = message.raw as LineMessage | LineMessage[]
    return Array.isArray(raw) ? raw : [raw]
  }

  const messages: LineMessage[] = []

  if (message.text) {
    messages.push({ type: 'text', text: message.text })
  }

  if (message.attachments) {
    for (const a of message.attachments) {
      messages.push(toLineAttachment(a))
    }
  }

  if (messages.length === 0) {
    throw new InstantProviderError(
      'LineDriver: cannot send an empty message — set `text`, `attachments`, or `raw`.',
      { provider: 'line', operation: 'send', status: 400 },
    )
  }

  if (message.quickReplies && message.quickReplies.length > 0) {
    const last = messages[messages.length - 1] as LineMessage & { quickReply?: LineQuickReply }
    last.quickReply = toLineQuickReply(message.quickReplies)
  }

  return messages
}

function toLineAttachment(a: Attachment): LineMessage {
  switch (a.type) {
    case 'image':
      return {
        type: 'image',
        originalContentUrl: a.url,
        previewImageUrl: a.previewUrl ?? a.url,
      }
    case 'video':
      return {
        type: 'video',
        originalContentUrl: a.url,
        previewImageUrl: a.previewUrl ?? a.url,
      }
    case 'audio':
      return {
        type: 'audio',
        originalContentUrl: a.url,
        duration: a.durationMs ?? 0,
      }
    case 'file':
      // LINE has no first-class "file" message — fall back to a text link.
      return { type: 'text', text: a.fileName ? `${a.fileName}\n${a.url}` : a.url }
    case 'location':
      return {
        type: 'location',
        title: a.title ?? 'Location',
        address: a.address ?? '',
        latitude: a.latitude,
        longitude: a.longitude,
      }
    case 'sticker':
      return { type: 'sticker', packageId: a.packageId, stickerId: a.stickerId }
  }
}

function toLineQuickReply(replies: readonly QuickReply[]): LineQuickReply {
  return {
    items: replies.slice(0, 13).map((r) => ({
      type: 'action',
      ...(r.iconUrl ? { imageUrl: r.iconUrl } : {}),
      action: toLineAction(r.label, r.action),
    })),
  }
}

function toLineAction(label: string, action: QuickReply['action']): LineAction {
  switch (action.type) {
    case 'message':
      return { type: 'message', label, text: action.text }
    case 'postback':
      return {
        type: 'postback',
        label,
        data: action.data,
        ...(action.displayText ? { displayText: action.displayText } : {}),
      }
    case 'uri':
      return { type: 'uri', label, uri: action.uri }
  }
}
