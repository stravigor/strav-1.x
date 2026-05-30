/**
 * Internal helpers shared by HTTP-based transports (Resend, SendGrid,
 * future Postmark / Mailgun).
 *
 * These are NOT exported from the package barrel — they're an
 * implementation detail of the transports. Tests reach in via the
 * relative path; user code constructs a `Message` and lets the
 * transport format it.
 */

import type { MailAddress, MailRecipient, MessageAttachment } from '../../message.ts'

// ─── Recipient normalisation ─────────────────────────────────────────────────

/**
 * Coerce a `MailRecipient` into `{ email, name? }` form.
 * Used by transports whose API takes structured-recipient JSON
 * (SendGrid: `[{ "email": "...", "name": "..." }]`).
 */
export function toStructured(r: MailRecipient): MailAddress {
  return typeof r === 'string' ? { email: r } : r
}

/**
 * Coerce a `MailRecipient` into RFC 5322 "Name <email>" form.
 * Used by transports that accept that as a single string (Resend:
 * `"to": "Alice <a@x>"`).
 */
export function toRfc5322(r: MailRecipient): string {
  if (typeof r === 'string') return r
  if (r.name === undefined) return r.email
  return `"${escapeQuotes(r.name)}" <${r.email}>`
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '\\"')
}

/** Apply `mapper` to either a single recipient or a list. */
export function mapRecipients<T>(
  value: MailRecipient | MailRecipient[],
  mapper: (r: MailRecipient) => T,
): T[] {
  return Array.isArray(value) ? value.map(mapper) : [mapper(value)]
}

// ─── Attachment encoding ─────────────────────────────────────────────────────

/**
 * Encode a `MessageAttachment`'s `content` to base64 — the wire format
 * every HTTP mail provider accepts. `Uint8Array` → btoa; `string` is
 * pass-through if `encoding: 'base64'`, otherwise UTF-8 → btoa.
 */
export function attachmentToBase64(a: MessageAttachment): string {
  if (typeof a.content === 'string') {
    if (a.encoding === 'base64') return a.content
    // UTF-8 string → bytes → base64.
    return uint8ToBase64(new TextEncoder().encode(a.content))
  }
  return uint8ToBase64(a.content)
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Bun supports btoa + the binary-string trick used in browsers; this
  // path stays portable to plain Node without pulling Buffer in.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// ─── Retry classification ────────────────────────────────────────────────────

/**
 * Best-effort guess at whether a transport failure is worth retrying.
 * Used in the `context.retryable` field of `MailTransportError` so
 * the Worker's `failed()` hook can log the hint (the Worker itself
 * doesn't read it — retry policy lives in `Job.maxAttempts` /
 * `Job.backoff`).
 *
 * Rule of thumb (matches HTTP semantics):
 *   - 5xx / network → retryable
 *   - 408 / 429 → retryable (timeout + rate-limit)
 *   - other 4xx → permanent
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true
  if (status === 408 || status === 429) return true
  return false
}
