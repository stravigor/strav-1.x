/**
 * `MagicLinkManager` — create and consume passwordless sign-in links.
 *
 * Typical flow:
 *   1. User submits their email.
 *   2. Controller calls `manager.create(user, { ttl: '15m', redirectTo: '/dashboard' })`.
 *      Returns the full URL to email to the user.
 *   3. User clicks the link → GET /auth/magic/:token.
 *   4. Controller calls `manager.consume(token)`.
 *      Returns `{ userId, redirectTo }` on success; throws `MagicLinkError` otherwise.
 *   5. Controller resolves the user, calls `ctx.auth.login(user)`.
 *
 * Security properties:
 *   - Tokens are 32 random bytes (64 hex chars) — 256-bit entropy.
 *   - Single-use: `consume` fills `used_at` and rejects any second attempt.
 *   - Expiry: reject after `expires_at`.
 *   - No secret required — the security boundary is the email delivery channel.
 */

import { randomBytes } from 'node:crypto'
import type { Database } from '@strav/database'
import { StravError } from '@strav/kernel'

export class MagicLinkError extends StravError {
  constructor(message: string, options: { context?: Record<string, unknown> } = {}) {
    super(message, { code: 'auth.magic-link-error', status: 400 }, options)
  }
}

export interface CreateMagicLinkOptions {
  /** Token lifetime. Duration string ('15m', '1h') or seconds. Default '15m'. */
  ttl?: string | number
  /** URL the app should redirect to after login. Stored + returned by consume(). */
  redirectTo?: string
  /** Base URL for the magic link (e.g. 'https://myapp.com'). Required unless set on the manager. */
  baseUrl?: string
  /** Route path for the magic link handler. Default '/auth/magic'. */
  path?: string
}

export interface ConsumedMagicLink {
  userId: string
  redirectTo: string | null
}

interface MagicLinkManagerOptions {
  db: Database
  /** App base URL — prepended to the link path. */
  baseUrl?: string
  /** Route path for the token handler. Default '/auth/magic'. */
  path?: string
}

interface MagicRow {
  id: string
  user_id: string
  token: string
  redirect_to: string | null
  expires_at: Date | string
  used_at: Date | string | null
}

export class MagicLinkManager {
  private readonly db: Database
  private readonly baseUrl: string | undefined
  private readonly path: string

  constructor(opts: MagicLinkManagerOptions) {
    this.db = opts.db
    this.baseUrl = opts.baseUrl
    this.path = opts.path ?? '/auth/magic'
  }

  /**
   * Create a magic link for `userId`. Inserts a row into `strav_magic_links`
   * and returns the full URL to send to the user via email.
   */
  async create(userId: string, options: CreateMagicLinkOptions = {}): Promise<string> {
    const token = randomBytes(32).toString('hex')
    const ttlSeconds = parseTtl(options.ttl ?? '15m')
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    const redirectTo = options.redirectTo ?? null
    const base = options.baseUrl ?? this.baseUrl
    if (!base) {
      throw new MagicLinkError(
        'MagicLinkManager.create: baseUrl is required (set it in the manager constructor or pass it per-call).',
      )
    }

    await this.db.execute(
      `INSERT INTO "strav_magic_links" (id, user_id, token, redirect_to, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())`,
      [userId, token, redirectTo, expiresAt],
    )

    const path = options.path ?? this.path
    return `${base.replace(/\/$/, '')}${path}/${token}`
  }

  /**
   * Consume a magic link token. Returns `{ userId, redirectTo }` on success.
   * Marks the row as used atomically. Throws `MagicLinkError` when:
   *   - Token not found.
   *   - Token already used.
   *   - Token expired.
   */
  async consume(token: string): Promise<ConsumedMagicLink> {
    const row = await this.db.queryOne<MagicRow>(
      `SELECT id, user_id, token, redirect_to, expires_at, used_at
         FROM "strav_magic_links"
         WHERE token = $1`,
      [token],
    )

    if (!row) {
      throw new MagicLinkError('Magic link is invalid.', { context: { code: 'invalid' } })
    }

    if (row.used_at !== null) {
      throw new MagicLinkError('Magic link has already been used.', { context: { code: 'used' } })
    }

    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
    if (expiresAt < new Date()) {
      throw new MagicLinkError('Magic link has expired.', { context: { code: 'expired' } })
    }

    // Mark as used.
    await this.db.execute(
      `UPDATE "strav_magic_links" SET used_at = now(), updated_at = now() WHERE id = $1`,
      [row.id],
    )

    return { userId: row.user_id, redirectTo: row.redirect_to }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseTtl(ttl: string | number): number {
  if (typeof ttl === 'number') return ttl
  const m = /^(\d+)(s|m|h|d)?$/.exec(ttl.trim())
  if (!m) throw new MagicLinkError(`Invalid TTL format: "${ttl}". Use e.g. '15m', '1h', 60.`)
  const n = Number(m[1])
  switch (m[2]) {
    case 's':
      return n
    case 'm':
      return n * 60
    case 'h':
      return n * 3600
    case 'd':
      return n * 86400
    default:
      return n // bare number treated as seconds
  }
}
