/**
 * `Message` — the wire-shape every Strav `Transport` accepts.
 *
 * Plain data, deliberately. The same `Message` literal a test handler
 * constructs by hand is the same shape a future `Mailable.build()` will
 * return — no driver-specific fields, no transport-specific options.
 * Transports translate this into their own provider format (SMTP
 * envelope, Resend JSON, SendGrid v3, etc.) on `send()`.
 *
 * Recipients
 *   `to` / `cc` / `bcc` / `replyTo` accept either a bare email string
 *   (`'alice@example.com'`) or a `{ email, name? }` object. A list of
 *   either is fine — `to: ['a@x', { email: 'b@x', name: 'Bob' }]` is
 *   legal. Use the structured form when the display name matters.
 *
 * Body
 *   At least one of `html` / `text` must be present. Transports that
 *   support multipart will send both when both are set; transports that
 *   only support one degrade as documented in the driver's notes.
 *
 * Headers + attachments
 *   `headers` is a flat string-to-string map; transports apply provider
 *   constraints (e.g. SMTP rejects newlines). `attachments` carries an
 *   optional list — see `MessageAttachment`. Per-driver size limits
 *   apply; transports throw on oversize content.
 */

export interface MailAddress {
  /** RFC 5322 addr-spec. Validated by the transport, not here. */
  email: string
  /** Optional display name. Joined as `"Name" <email>` by transports that support it. */
  name?: string
}

/** Either a bare email or a `{ email, name? }` pair. */
export type MailRecipient = string | MailAddress

/**
 * File attached to a message. `content` is the raw bytes; pass a
 * `Uint8Array` for binary data or a UTF-8 `string` for text. When
 * passing a string that's actually a base64-encoded payload, set
 * `encoding: 'base64'` so transports decode it before transmission.
 */
export interface MessageAttachment {
  filename: string
  content: string | Uint8Array
  /** Defaults to `application/octet-stream` if omitted; transports may sniff from filename. */
  contentType?: string
  /** How `content` is encoded when it's a string. Defaults to `'utf-8'`. */
  encoding?: 'utf-8' | 'base64'
}

export interface Message {
  to: MailRecipient | MailRecipient[]
  /**
   * Optional. When omitted, `MailManager.send` substitutes `config.mail.from`
   * before handing the message to the transport. If neither is set, the
   * transport throws — there is no implicit "MAIL FROM:" guess.
   */
  from?: MailRecipient
  cc?: MailRecipient | MailRecipient[]
  bcc?: MailRecipient | MailRecipient[]
  replyTo?: MailRecipient | MailRecipient[]
  subject: string
  /** HTML body. At least one of `html` / `text` is required. */
  html?: string
  /** Plain-text body. At least one of `html` / `text` is required. */
  text?: string
  /** Flat header map; values must be ASCII single-line strings. */
  headers?: Record<string, string>
  attachments?: MessageAttachment[]
}
