/**
 * `ResendTransport` — sends mail via the Resend HTTP API.
 *
 *   POST {endpoint}/emails
 *   Authorization: Bearer {apiKey}
 *   Content-Type: application/json
 *
 *   { from, to, subject, html?, text?, cc?, bcc?, reply_to?,
 *     headers?, attachments?: [{ filename, content (base64) }] }
 *
 * Resend accepts recipients as either `"Name <email>"` strings or bare
 * emails — this transport normalises to the RFC 5322 form so display
 * names always render.
 *
 * Failure model: any non-2xx response throws `MailTransportError`.
 * The `context` payload carries `provider`, `status`, `retryable`
 * (heuristic), and the parsed provider error body when present — the
 * Worker's `failed()` hook can log it as-is.
 *
 * Networking: a transient `fetch` rejection (DNS, TCP reset, TLS
 * timeout) wraps as `MailTransportError` with `context.retryable: true`
 * — the underlying `Error.cause` carries the original.
 *
 * @see https://resend.com/docs/api-reference/emails/send-email
 */

import type { Message } from '../message.ts'
import type { Transport } from '../transport.ts'
import { MailTransportError } from '../transport_error.ts'
import {
  attachmentToBase64,
  isRetryableStatus,
  mapRecipients,
  toRfc5322,
} from './internal/normalize.ts'

export interface ResendTransportOptions {
  /** Resend API key (`re_…`). Read from env / config, never hard-coded. */
  apiKey: string
  /**
   * Base URL of the Resend API. Defaults to `https://api.resend.com`.
   * Override for self-hosted / regional / mocked endpoints.
   */
  endpoint?: string
  /**
   * Custom `fetch` for tests. Defaults to the global `fetch`. The
   * transport doesn't validate its return shape beyond `.ok` + `.json()`
   * — pass a plain stub.
   */
  fetch?: typeof fetch
}

interface ResendRequestBody {
  from: string
  to: string[]
  subject: string
  html?: string
  text?: string
  cc?: string[]
  bcc?: string[]
  reply_to?: string | string[]
  headers?: Record<string, string>
  attachments?: Array<{ filename: string; content: string; content_type?: string }>
}

export class ResendTransport implements Transport {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch

  constructor(opts: ResendTransportOptions) {
    this.apiKey = opts.apiKey
    this.endpoint = (opts.endpoint ?? 'https://api.resend.com').replace(/\/$/, '')
    this.fetchFn = opts.fetch ?? fetch
  }

  async send(message: Message): Promise<void> {
    if (message.from === undefined) {
      throw new MailTransportError('Resend requires `from` — none on the message or default.', {
        context: { provider: 'resend', retryable: false },
      })
    }

    const body: ResendRequestBody = {
      from: toRfc5322(message.from),
      to: mapRecipients(message.to, toRfc5322),
      subject: message.subject,
    }
    if (message.html !== undefined) body.html = message.html
    if (message.text !== undefined) body.text = message.text
    if (message.cc !== undefined) body.cc = mapRecipients(message.cc, toRfc5322)
    if (message.bcc !== undefined) body.bcc = mapRecipients(message.bcc, toRfc5322)
    if (message.replyTo !== undefined) {
      const list = mapRecipients(message.replyTo, toRfc5322)
      const [first] = list
      body.reply_to = list.length === 1 && first !== undefined ? first : list
    }
    if (message.headers !== undefined) body.headers = message.headers
    if (message.attachments !== undefined && message.attachments.length > 0) {
      body.attachments = message.attachments.map((a) => {
        const out: { filename: string; content: string; content_type?: string } = {
          filename: a.filename,
          content: attachmentToBase64(a),
        }
        if (a.contentType !== undefined) out.content_type = a.contentType
        return out
      })
    }

    let response: Response
    try {
      response = await this.fetchFn(`${this.endpoint}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      // Network-level failure — no HTTP response. Treat as retryable.
      throw new MailTransportError(
        `Resend send failed at the network layer: ${(cause as Error).message ?? String(cause)}`,
        { context: { provider: 'resend', retryable: true }, cause },
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
      `Resend rejected the send (HTTP ${response.status} ${response.statusText}).`,
      {
        context: {
          provider: 'resend',
          status: response.status,
          retryable: isRetryableStatus(response.status),
          providerError,
        },
      },
    )
  }
}
