/**
 * `SendGridTransport` — sends mail via the SendGrid v3 API.
 *
 *   POST {endpoint}/v3/mail/send
 *   Authorization: Bearer {apiKey}
 *   Content-Type: application/json
 *
 *   {
 *     personalizations: [{ to, cc?, bcc?, subject?, headers? }],
 *     from, reply_to?,
 *     subject,
 *     content: [{ type: 'text/plain', value }, { type: 'text/html', value }],
 *     attachments?: [{ content (base64), filename, type, disposition }],
 *     headers?,
 *   }
 *
 * SendGrid wants structured recipients (`{ "email": "...", "name": "..." }`)
 * and a multi-part `content` array. The transport normalises both.
 *
 * SendGrid returns `202 Accepted` on success (no body). Any other
 * status throws `MailTransportError` with `provider: 'sendgrid'` and
 * the parsed error body when present.
 *
 * @see https://docs.sendgrid.com/api-reference/mail-send/mail-send
 */

import type { MailAddress, Message } from '../message.ts'
import type { Transport } from '../transport.ts'
import { MailTransportError } from '../transport_error.ts'
import {
  attachmentToBase64,
  isRetryableStatus,
  mapRecipients,
  toStructured,
} from './internal/normalize.ts'

export interface SendGridTransportOptions {
  /** SendGrid API key (`SG.…`). Read from env / config, never hard-coded. */
  apiKey: string
  /**
   * Base URL of the SendGrid API. Defaults to `https://api.sendgrid.com`.
   * Override for regional / mocked endpoints.
   */
  endpoint?: string
  /** Custom `fetch` for tests. */
  fetch?: typeof fetch
}

interface SendGridContent {
  type: 'text/plain' | 'text/html'
  value: string
}

interface SendGridPersonalization {
  to: MailAddress[]
  cc?: MailAddress[]
  bcc?: MailAddress[]
}

interface SendGridAttachment {
  content: string
  filename: string
  type?: string
  disposition: 'attachment'
}

interface SendGridRequestBody {
  personalizations: SendGridPersonalization[]
  from: MailAddress
  reply_to?: MailAddress
  subject: string
  content: SendGridContent[]
  attachments?: SendGridAttachment[]
  headers?: Record<string, string>
}

export class SendGridTransport implements Transport {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch

  constructor(opts: SendGridTransportOptions) {
    this.apiKey = opts.apiKey
    this.endpoint = (opts.endpoint ?? 'https://api.sendgrid.com').replace(/\/$/, '')
    this.fetchFn = opts.fetch ?? fetch
  }

  async send(message: Message): Promise<void> {
    if (message.from === undefined) {
      throw new MailTransportError('SendGrid requires `from` — none on the message or default.', {
        context: { provider: 'sendgrid', retryable: false },
      })
    }

    // SendGrid requires at least one content entry. The order matters —
    // text/plain before text/html, per the v3 docs.
    const content: SendGridContent[] = []
    if (message.text !== undefined) content.push({ type: 'text/plain', value: message.text })
    if (message.html !== undefined) content.push({ type: 'text/html', value: message.html })
    if (content.length === 0) {
      throw new MailTransportError(
        'SendGrid: Message must include at least one of `html` or `text`.',
        { context: { provider: 'sendgrid', retryable: false } },
      )
    }

    const personalization: SendGridPersonalization = {
      to: mapRecipients(message.to, toStructured),
    }
    if (message.cc !== undefined) personalization.cc = mapRecipients(message.cc, toStructured)
    if (message.bcc !== undefined) personalization.bcc = mapRecipients(message.bcc, toStructured)

    const body: SendGridRequestBody = {
      personalizations: [personalization],
      from: toStructured(message.from),
      subject: message.subject,
      content,
    }
    if (message.replyTo !== undefined) {
      // SendGrid v3 single reply_to. If the caller passes a list, take
      // the first — the rest are best-effort dropped (multi reply-to
      // goes through `reply_to_list`, a newer field; not modelled here
      // until a real user needs it).
      const list = mapRecipients(message.replyTo, toStructured)
      if (list[0] !== undefined) body.reply_to = list[0]
    }
    if (message.headers !== undefined) body.headers = message.headers
    if (message.attachments !== undefined && message.attachments.length > 0) {
      body.attachments = message.attachments.map((a) => {
        const out: SendGridAttachment = {
          content: attachmentToBase64(a),
          filename: a.filename,
          disposition: 'attachment',
        }
        if (a.contentType !== undefined) out.type = a.contentType
        return out
      })
    }

    let response: Response
    try {
      response = await this.fetchFn(`${this.endpoint}/v3/mail/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new MailTransportError(
        `SendGrid send failed at the network layer: ${(cause as Error).message ?? String(cause)}`,
        { context: { provider: 'sendgrid', retryable: true }, cause },
      )
    }

    // SendGrid returns 202 Accepted on success. Anything else is a failure.
    if (response.ok) return

    let providerError: unknown
    try {
      providerError = await response.json()
    } catch {
      providerError = await response.text().catch(() => undefined)
    }

    throw new MailTransportError(
      `SendGrid rejected the send (HTTP ${response.status} ${response.statusText}).`,
      {
        context: {
          provider: 'sendgrid',
          status: response.status,
          retryable: isRetryableStatus(response.status),
          providerError,
        },
      },
    )
  }
}
