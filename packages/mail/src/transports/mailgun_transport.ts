/**
 * `MailgunTransport` — sends mail via the Mailgun HTTP API.
 *
 *   POST {endpoint}/v3/{domain}/messages
 *   Authorization: Basic base64('api:{apiKey}')
 *   Content-Type: multipart/form-data    (set automatically by fetch)
 *
 * Mailgun differs from Resend / SendGrid in two ways:
 *
 *   1. Auth is HTTP Basic with a fixed `"api"` username — the API key
 *      is the password. We construct the credential internally; the
 *      config only collects the key.
 *   2. The request body is `FormData`, not JSON. Recipients are
 *      comma-separated strings on `to` / `cc` / `bcc`; custom headers
 *      ride as `h:X-Header-Name` form fields; attachments are `Blob`
 *      parts on the `attachment` field.
 *
 * Region routing — EU customers override `endpoint` to
 * `https://api.eu.mailgun.net`. The default is the US endpoint.
 *
 * @see https://documentation.mailgun.com/docs/mailgun/api-reference/openapi-final/tag/Messages/
 */

import type { Message, MessageAttachment } from '../message.ts'
import type { Transport } from '../transport.ts'
import { MailTransportError } from '../transport_error.ts'
import { isRetryableStatus, mapRecipients, toRfc5322 } from './internal/normalize.ts'

export interface MailgunTransportOptions {
  /** Mailgun API key. Pull from env in `config/mail.ts`; never hard-code. */
  apiKey: string
  /**
   * Sending domain registered with Mailgun (e.g. `mg.acme.com`). Used
   * as the path component of the API URL. Distinct from the recipient
   * domain — this is YOUR Mailgun-verified domain.
   */
  domain: string
  /**
   * Base URL of the Mailgun API. Defaults to `https://api.mailgun.net`.
   * Set to `https://api.eu.mailgun.net` for EU-region accounts.
   */
  endpoint?: string
  /** Custom `fetch` for tests. */
  fetch?: typeof fetch
}

export class MailgunTransport implements Transport {
  private readonly apiKey: string
  private readonly domain: string
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch

  constructor(opts: MailgunTransportOptions) {
    this.apiKey = opts.apiKey
    this.domain = opts.domain
    this.endpoint = (opts.endpoint ?? 'https://api.mailgun.net').replace(/\/$/, '')
    this.fetchFn = opts.fetch ?? fetch
  }

  async send(message: Message): Promise<void> {
    if (message.from === undefined) {
      throw new MailTransportError('Mailgun requires `from` — none on the message or default.', {
        context: { provider: 'mailgun', retryable: false },
      })
    }

    const form = new FormData()
    form.append('from', toRfc5322(message.from))
    form.append('to', mapRecipients(message.to, toRfc5322).join(', '))
    form.append('subject', message.subject)

    if (message.cc !== undefined) {
      form.append('cc', mapRecipients(message.cc, toRfc5322).join(', '))
    }
    if (message.bcc !== undefined) {
      form.append('bcc', mapRecipients(message.bcc, toRfc5322).join(', '))
    }
    if (message.replyTo !== undefined) {
      // Mailgun expects a single Reply-To header value. Multiple
      // reply-tos collapse to a comma-separated list inside the
      // single header — RFC 5322 allows that.
      form.append('h:Reply-To', mapRecipients(message.replyTo, toRfc5322).join(', '))
    }
    if (message.html !== undefined) form.append('html', message.html)
    if (message.text !== undefined) form.append('text', message.text)

    if (message.headers !== undefined) {
      for (const [name, value] of Object.entries(message.headers)) {
        // `h:` prefix turns the form field into an outbound header.
        form.append(`h:${name}`, value)
      }
    }

    if (message.attachments !== undefined) {
      for (const a of message.attachments) {
        form.append('attachment', attachmentToBlob(a), a.filename)
      }
    }

    const credentials = btoa(`api:${this.apiKey}`)
    let response: Response
    try {
      response = await this.fetchFn(`${this.endpoint}/v3/${this.domain}/messages`, {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}` },
        body: form,
      })
    } catch (cause) {
      throw new MailTransportError(
        `Mailgun send failed at the network layer: ${(cause as Error).message ?? String(cause)}`,
        { context: { provider: 'mailgun', retryable: true }, cause },
      )
    }

    if (response.ok) return

    let providerError: unknown
    try {
      providerError = await response.json()
    } catch {
      providerError = await response.text().catch(() => undefined)
    }

    throw new MailTransportError(
      `Mailgun rejected the send (HTTP ${response.status} ${response.statusText}).`,
      {
        context: {
          provider: 'mailgun',
          status: response.status,
          retryable: isRetryableStatus(response.status),
          providerError,
        },
      },
    )
  }
}

/**
 * Mailgun accepts attachments as `Blob` parts on the multipart form —
 * the same byte stream the user supplied, wrapped with the declared
 * MIME type. Unlike Resend / SendGrid we don't base64-encode here;
 * `fetch` handles the multipart boundary and binary framing.
 *
 * For `encoding: 'base64'` string inputs we DO need to decode first —
 * Mailgun expects raw bytes on the wire, not base64 text.
 */
function attachmentToBlob(a: MessageAttachment): Blob {
  const type = a.contentType ?? 'application/octet-stream'
  if (typeof a.content === 'string') {
    if (a.encoding === 'base64') {
      // Decode base64 → bytes so the wire payload is the actual file.
      const binary = atob(a.content)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type })
    }
    return new Blob([a.content], { type })
  }
  return new Blob([a.content], { type })
}
