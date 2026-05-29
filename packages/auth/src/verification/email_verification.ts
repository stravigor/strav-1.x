/**
 * `EmailVerification` — signed, expiring URLs for email address confirmation.
 *
 * Unlike magic links (which authenticate), email verification links only
 * prove the user owns an email address. The flow:
 *   1. After registration, generate a signed URL and email it.
 *   2. User clicks → GET /auth/verify/:token.
 *   3. Controller calls `verify(token)` → returns the userId.
 *   4. Controller marks the user's `email_verified_at` column.
 *
 * Token format: `<userId>.<timestamp>.<signature>` where the signature is
 * HMAC-SHA256 over `<userId>.<timestamp>` with `config.app.key` as the
 * secret. This is stateless — no DB table needed. The tradeoff: tokens
 * cannot be individually revoked (only expired by timestamp). Apps that
 * need revocable verification tokens should use `MagicLinkManager` instead.
 *
 * The `verified` middleware (in `@strav/auth/middleware`) checks that
 * `ctx.auth.user.email_verified_at` is not null and throws `AuthError`
 * if the user hasn't verified.
 */

import { createHmac } from 'node:crypto'
import { StravError } from '@strav/kernel'

export class EmailVerificationError extends StravError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, { code: 'auth.email-verification-error', status: 400 }, options)
  }
}

export interface EmailVerificationOptions {
  /** Token lifetime in seconds. Default 86400 (24 hours). */
  ttlSeconds?: number
  /** Route path for the verification handler. Default '/auth/verify'. */
  path?: string
  /** Override current timestamp (for deterministic tests). */
  now?: number
}

export interface EmailVerificationResult {
  userId: string
}

export class EmailVerification {
  private readonly appKey: string
  private readonly ttlSeconds: number
  private readonly path: string
  private readonly baseUrl: string | undefined

  constructor(opts: { appKey: string; baseUrl?: string; ttlSeconds?: number; path?: string }) {
    this.appKey = opts.appKey
    this.baseUrl = opts.baseUrl
    this.ttlSeconds = opts.ttlSeconds ?? 86_400
    this.path = opts.path ?? '/auth/verify'
  }

  /**
   * Generate a signed verification URL. Pass to an email job, e.g.:
   *   `await SendVerificationEmail.dispatch({ userId, url: ev.signedUrl(userId) })`
   */
  signedUrl(userId: string, options: EmailVerificationOptions = {}): string {
    const ts = options.now ?? Math.floor(Date.now() / 1000)
    const sig = this.sign(`${userId}.${ts}`)
    const token = `${userId}.${ts}.${sig}`
    const path = options.path ?? this.path
    const base = this.baseUrl?.replace(/\/$/, '') ?? ''
    return `${base}${path}/${encodeURIComponent(token)}`
  }

  /**
   * Verify a token from the URL. Returns `{ userId }` on success.
   * Throws `EmailVerificationError` on invalid / expired tokens.
   */
  verify(token: string, options: EmailVerificationOptions = {}): EmailVerificationResult {
    const parts = decodeURIComponent(token).split('.')
    if (parts.length !== 3) {
      throw new EmailVerificationError('Invalid verification token.', {
        context: { code: 'invalid' },
      })
    }
    const [userId, tsStr, sig] = parts as [string, string, string]
    const ts = Number(tsStr)
    if (!Number.isInteger(ts)) {
      throw new EmailVerificationError('Invalid verification token.', {
        context: { code: 'invalid' },
      })
    }

    const expected = this.sign(`${userId}.${ts}`)
    if (!timingSafeEqual(sig, expected)) {
      throw new EmailVerificationError('Invalid verification token.', {
        context: { code: 'invalid' },
      })
    }

    const now = options.now ?? Math.floor(Date.now() / 1000)
    const ttl = options.ttlSeconds ?? this.ttlSeconds
    if (ts + ttl < now) {
      throw new EmailVerificationError('Verification link has expired.', {
        context: { code: 'expired' },
      })
    }

    return { userId }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.appKey).update(payload).digest('hex')
  }
}

/** Constant-time string equality to prevent timing attacks on the signature. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  let diff = 0
  for (let i = 0; i < bufA.length; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0)
  }
  return diff === 0
}
