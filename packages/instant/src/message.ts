/**
 * `OutgoingMessage` — the lowest-common-denominator wire shape the
 * `InstantManager` exposes for portable sends. Apps that target
 * multiple providers stick to these fields; apps that need
 * provider-specific richness (LINE Flex, WhatsApp templates,
 * Messenger generic templates) drop down to `raw` or call into the
 * subpath driver directly.
 *
 * Every field is optional so the same shape can carry "just text",
 * "text + image", "quick replies only", etc. Drivers throw
 * `ProviderUnsupportedError` for fields they can't fulfil — apps
 * gate on `driver.capabilities` to branch ahead of the call.
 */

export interface OutgoingMessage {
  /** Plain-text body. Required for `send.text` calls. */
  text?: string
  /** Media + structured content attached to the message. */
  attachments?: Attachment[]
  /** Buttons rendered alongside the message (LINE quick reply, WhatsApp buttons, Messenger quick replies). */
  quickReplies?: QuickReply[]
  /**
   * Provider-native message object. When set, the driver
   * forwards it verbatim and ignores the LCD fields above.
   * Use this when reaching for provider-specific richness
   * (e.g. a `FlexBubble` from `@strav/instant/line`).
   */
  raw?: unknown
}

export type Attachment =
  | { type: 'image'; url: string; previewUrl?: string }
  | { type: 'video'; url: string; previewUrl?: string; durationMs?: number }
  | { type: 'audio'; url: string; durationMs?: number }
  | { type: 'file'; url: string; fileName?: string; sizeBytes?: number }
  | { type: 'location'; latitude: number; longitude: number; title?: string; address?: string }
  | { type: 'sticker'; packageId: string; stickerId: string }

export interface QuickReply {
  label: string
  /** Action fired when the reply is tapped. */
  action:
    | { type: 'message'; text: string }
    | { type: 'postback'; data: string; displayText?: string }
    | { type: 'uri'; uri: string }
  /** Icon shown next to the label, where the provider supports it. */
  iconUrl?: string
}

/**
 * `SendResult` — what every send call returns. Drivers populate
 * `messageId` when the provider hands one back (LINE's
 * `x-line-request-id`, WhatsApp's `messages[0].id`); some only
 * confirm acceptance and leave it undefined.
 */
export interface SendResult {
  /** Driver name (`'line'`, `'whatsapp'`, …). */
  provider: string
  /** Whether the upstream API accepted the send. */
  accepted: boolean
  /** Provider-issued reference, when one exists. */
  messageId?: string
  /** Raw provider response for advanced inspection. */
  raw?: unknown
}
