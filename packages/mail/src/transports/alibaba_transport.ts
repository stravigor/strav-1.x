/**
 * `AlibabaDmTransport` — sends mail via Alibaba Cloud DirectMail (DM).
 *
 *   POST {endpoint}/?{rpc-v1 form-encoded params}
 *   Content-Type: application/x-www-form-urlencoded
 *
 * Why this is here: DirectMail is the dominant transactional-email
 * provider for apps deployed inside Alibaba Cloud and for senders
 * targeting Chinese / South-East Asian inboxes — domestic deliverability
 * to QQ, 163, NetEase, etc. routinely outperforms Western providers.
 *
 * Wire shape — DirectMail exposes a classic Alibaba-Cloud RPC API:
 *
 *   - Authentication: HMAC-SHA1 signature ("Signature V1") over a
 *     URL-encoded sorted-key canonical query string. Key is
 *     `{accessKeySecret}&`. We compute it per request — no SDK
 *     dependency.
 *   - Payload: form-urlencoded, NOT JSON. JSON is what the API
 *     *responds* with (`Format=JSON`), not what we send.
 *   - Action: `SingleSendMail` for transactional sends. The other
 *     action (`BatchSendMail`) requires a pre-uploaded template and
 *     is out of scope for an outbound `Transport`.
 *
 * Limitations forced by the API surface:
 *
 *   - **No attachments.** `SingleSendMail` has no attachment field;
 *     attachments require SMTP relay or `BatchSendMail` with a
 *     template-uploaded file. We throw `MailTransportError` rather
 *     than silently drop bytes the caller expected to send.
 *   - **No cc / bcc.** `SingleSendMail` accepts a comma-separated
 *     `ToAddress` (up to 100) but exposes no cc / bcc parameters.
 *     Merging cc / bcc into `to` would silently expose recipient
 *     addresses, so we throw instead.
 *   - **Custom headers are dropped.** `SingleSendMail` does not
 *     expose arbitrary header injection. DirectMail's `TagName`
 *     field covers the common "tag this send" use-case — set
 *     `tagName` on the transport options if you need it.
 *
 * Regions — DirectMail is region-scoped. The transport defaults to
 * the global endpoint (`https://dm.aliyuncs.com`); SEA-region
 * customers override `endpoint` to e.g.
 * `https://dm.ap-southeast-1.aliyuncs.com` (Singapore) or
 * `https://dm.ap-southeast-5.aliyuncs.com` (Jakarta).
 *
 * @see https://www.alibabacloud.com/help/en/direct-mail/developer-reference/api-dm-2015-11-23-singlesendmail
 */

import { createHmac, randomUUID } from 'node:crypto'
import type { Message } from '../message.ts'
import type { Transport } from '../transport.ts'
import { MailTransportError } from '../transport_error.ts'
import { isRetryableStatus, mapRecipients, toStructured } from './internal/normalize.ts'

const DEFAULT_ENDPOINT = 'https://dm.aliyuncs.com'
const API_VERSION = '2015-11-23'

export interface AlibabaDmTransportOptions {
  /** Alibaba Cloud AccessKey ID. Pull from env in `config/mail.ts`; never hard-code. */
  accessKeyId: string
  /** Alibaba Cloud AccessKey Secret. */
  accessKeySecret: string
  /**
   * Verified DirectMail sender address (the "AccountName" — must be
   * pre-registered in the DirectMail console). DM enforces that
   * outbound senders match a configured account; using `message.from`
   * as `AccountName` would fail for every send that uses a per-user
   * `from`. Configure the verified account here, set the display name
   * via `message.from.name`.
   */
  accountName: string
  /**
   * Base URL of the DirectMail API. Defaults to `https://dm.aliyuncs.com`
   * (global). Region overrides — common in SEA deployments:
   *
   *   - `https://dm.ap-southeast-1.aliyuncs.com` — Singapore
   *   - `https://dm.ap-southeast-2.aliyuncs.com` — Sydney
   *   - `https://dm.ap-southeast-3.aliyuncs.com` — Kuala Lumpur
   *   - `https://dm.ap-southeast-5.aliyuncs.com` — Jakarta
   */
  endpoint?: string
  /**
   * Optional `TagName` attached to every send — surfaces in DirectMail
   * console analytics. Equivalent to a fixed `X-Tag` header on
   * Western providers.
   */
  tagName?: string
  /**
   * Enable click-tracking — DirectMail rewrites links in the HTML
   * body. Off by default; turn on per-deployment if you actually
   * consume the analytics.
   */
  clickTrace?: boolean
  /** Custom `fetch` for tests. */
  fetch?: typeof fetch
  /** Override clock for deterministic signatures in tests. */
  now?: () => Date
  /** Override SignatureNonce generation for deterministic signatures in tests. */
  nonce?: () => string
}

export class AlibabaDmTransport implements Transport {
  private readonly accessKeyId: string
  private readonly accessKeySecret: string
  private readonly accountName: string
  private readonly endpoint: string
  private readonly tagName: string | undefined
  private readonly clickTrace: '0' | '1'
  private readonly fetchFn: typeof fetch
  private readonly nowFn: () => Date
  private readonly nonceFn: () => string

  constructor(opts: AlibabaDmTransportOptions) {
    this.accessKeyId = opts.accessKeyId
    this.accessKeySecret = opts.accessKeySecret
    this.accountName = opts.accountName
    this.endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '')
    this.tagName = opts.tagName
    this.clickTrace = opts.clickTrace ? '1' : '0'
    this.fetchFn = opts.fetch ?? fetch
    this.nowFn = opts.now ?? (() => new Date())
    this.nonceFn = opts.nonce ?? (() => randomUUID())
  }

  async send(message: Message): Promise<void> {
    if (message.from === undefined) {
      throw new MailTransportError('Alibaba DM requires `from` — none on the message or default.', {
        context: { provider: 'alibaba', retryable: false },
      })
    }
    if (message.cc !== undefined || message.bcc !== undefined) {
      throw new MailTransportError(
        'Alibaba DM SingleSendMail does not support cc/bcc — send a separate message per recipient set.',
        { context: { provider: 'alibaba', retryable: false } },
      )
    }
    if (message.attachments !== undefined && message.attachments.length > 0) {
      throw new MailTransportError(
        'Alibaba DM SingleSendMail does not support attachments. Use SMTP relay or BatchSendMail with a template-uploaded file.',
        { context: { provider: 'alibaba', retryable: false } },
      )
    }

    const fromAddress = toStructured(message.from)
    const toAddresses = mapRecipients(message.to, toStructured)
    if (toAddresses.length === 0) {
      throw new MailTransportError('Alibaba DM requires at least one `to` recipient.', {
        context: { provider: 'alibaba', retryable: false },
      })
    }

    const params: Record<string, string> = {
      // Common RPC parameters.
      Action: 'SingleSendMail',
      Version: API_VERSION,
      Format: 'JSON',
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: this.nonceFn(),
      Timestamp: toAlibabaTimestamp(this.nowFn()),
      // Action-specific parameters.
      AccountName: this.accountName,
      // AddressType=1 → send from a configured sender account (the normal
      // path). 0 is reserved for "random sender" which we don't expose.
      AddressType: '1',
      ReplyToAddress: message.replyTo === undefined ? 'false' : 'true',
      ToAddress: toAddresses.map((a) => a.email).join(','),
      Subject: message.subject,
      ClickTrace: this.clickTrace,
    }

    if (fromAddress.name !== undefined) params['FromAlias'] = fromAddress.name
    if (message.html !== undefined) params['HtmlBody'] = message.html
    if (message.text !== undefined) params['TextBody'] = message.text
    if (this.tagName !== undefined) params['TagName'] = this.tagName

    if (message.replyTo !== undefined) {
      // DM SingleSendMail accepts a single ReplyAddress. If the caller
      // passed multiple, we use the first — matches what DM would do if
      // we crammed extras into a header it doesn't read.
      const [first] = mapRecipients(message.replyTo, toStructured)
      if (first !== undefined) {
        params['ReplyAddress'] = first.email
        if (first.name !== undefined) params['ReplyAddressAlias'] = first.name
      }
    }

    params['Signature'] = signRpcV1(params, 'POST', this.accessKeySecret)

    let response: Response
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: encodeForm(params),
      })
    } catch (cause) {
      throw new MailTransportError(
        `Alibaba DM send failed at the network layer: ${(cause as Error).message ?? String(cause)}`,
        { context: { provider: 'alibaba', retryable: true }, cause },
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
      `Alibaba DM rejected the send (HTTP ${response.status} ${response.statusText}).`,
      {
        context: {
          provider: 'alibaba',
          status: response.status,
          retryable: isRetryableStatus(response.status),
          providerError,
        },
      },
    )
  }
}

/**
 * Alibaba Cloud RPC v1 signature.
 *
 *   StringToSign = HTTPMethod + "&" + pct(/) + "&" + pct(canonicalQueryString)
 *   Signature    = base64(HMAC-SHA1(StringToSign, accessKeySecret + "&"))
 *
 * The trailing `&` on the HMAC key is mandated by the spec — it is
 * NOT a bug. Same with the literal `&` separators in `StringToSign`.
 */
function signRpcV1(
  params: Record<string, string>,
  method: string,
  accessKeySecret: string,
): string {
  const sortedKeys = Object.keys(params).sort()
  const canonical = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k] as string)}`)
    .join('&')
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64')
}

/**
 * Alibaba's percent-encoding rules — RFC 3986 strict, with the
 * additional fix-ups that bring `encodeURIComponent` into line:
 * encode `!`, `'`, `(`, `)`, `*`, but leave `~` alone (which
 * `encodeURIComponent` already does in modern engines).
 */
function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

function encodeForm(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join('&')
}

/** ISO 8601 in UTC with seconds precision — `2025-01-15T08:30:00Z`. */
function toAlibabaTimestamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}
