/**
 * `LogTransport` — writes outgoing mail to a `Logger` channel instead
 * of a real transport.
 *
 * Local-dev default. Apps point `config.mail.default` at the `'log'`
 * transport so that `bun dev` prints what would have been sent without
 * touching SMTP / Resend / SendGrid. Production never uses this — the
 * Mail body sits in logs verbatim.
 *
 * Output shape
 *   The transport emits one structured record per `send()`:
 *
 *     logger.info('mail.sent', { mail: { to, from, subject, ... } })
 *
 *   The Logger contract is `(msg, fields?)`, so the event identifier
 *   `'mail.sent'` is the first arg and the structured payload is the
 *   second. Bodies are not logged by default — putting full HTML into
 *   a log channel is wasteful in dev and unsafe in shared environments.
 *   Set `includeBody: true` to opt in (intended only for local debugging).
 */

import type { Logger } from '@strav/kernel'
import type { Message } from '../message.ts'
import type { Transport } from '../transport.ts'

export interface LogTransportOptions {
  /** Logger to write records to. Typically a named channel like `'mail'`. */
  logger: Logger
  /** Log level for outgoing records. Default `'info'`. */
  level?: 'debug' | 'info'
  /**
   * Include `html` / `text` bodies in the log record. Default `false`
   * — bodies in logs are noisy and can leak PII. Flip on only for
   * local debugging.
   */
  includeBody?: boolean
}

export class LogTransport implements Transport {
  private readonly logger: Logger
  private readonly level: 'debug' | 'info'
  private readonly includeBody: boolean

  constructor(opts: LogTransportOptions) {
    this.logger = opts.logger
    this.level = opts.level ?? 'info'
    this.includeBody = opts.includeBody ?? false
  }

  async send(message: Message): Promise<void> {
    const record: Record<string, unknown> = {
      to: message.to,
      from: message.from,
      subject: message.subject,
      hasHtml: message.html !== undefined,
      hasText: message.text !== undefined,
    }
    if (message.cc !== undefined) record.cc = message.cc
    if (message.bcc !== undefined) record.bcc = message.bcc
    if (message.replyTo !== undefined) record.replyTo = message.replyTo
    if (message.headers !== undefined) record.headers = message.headers
    if (message.attachments !== undefined) {
      record.attachments = message.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
      }))
    }
    if (this.includeBody) {
      if (message.html !== undefined) record.html = message.html
      if (message.text !== undefined) record.text = message.text
    }
    this.logger[this.level]('mail.sent', { mail: record })
  }
}
