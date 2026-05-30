/**
 * `AccessTokenRepository` — mint, verify, and revoke bearer tokens.
 *
 * Token format: `<row_id>|<secret>`. The row's PK is the cleartext
 * identifier (lookup is a primary-key hit); the secret is hashed with
 * SHA-256 for storage. Verification is a constant-time compare against
 * the stored hash. Same pattern Laravel Sanctum + Stripe + GitHub use.
 *
 * Methods that go beyond Repository<TModel>:
 *   - `createToken(userId, name, opts?)` — mints a fresh token, persists
 *     the hash, returns `{ plaintext, model }`. The caller sees the
 *     plaintext ONCE; future requests authenticate by handing the
 *     plaintext back.
 *   - `findByPlaintext(token)` — parses, looks up by id, verifies the
 *     hash, checks `expires_at`. Returns the AccessToken row or null.
 *   - `revokeAllForUser(userId)` — bulk delete for "log out everywhere"
 *     or "user deleted" flows.
 *
 * Why split the plaintext into id + secret instead of one opaque value:
 * lookup-by-PK is O(1); lookup by `hash` column would force a unique
 * index AND a full hash comparison on every authenticate. The id half
 * is public anyway (sent on every request); the secret half is what
 * authenticates.
 */

import { quoteIdent, Repository } from '@strav/database'
import { constantTimeEqual, randomToken, sha256, ulid } from '@strav/kernel'
import { AccessToken } from './access_token.ts'
import { accessTokenSchema } from './access_token_schema.ts'

const SECRET_BYTES = 32
const TOKEN_SEPARATOR = '|'

export interface CreateTokenOptions {
  /** Lifetime in seconds. Omit / `null` → never expires. */
  expiresInSeconds?: number | null
}

export interface MintedToken {
  /** The full plaintext token. Show to the user ONCE — it's not recoverable. */
  plaintext: string
  /** The persisted row (without the plaintext secret — `model.hash` is the SHA-256 of it). */
  model: AccessToken
}

export class AccessTokenRepository extends Repository<AccessToken> {
  static override readonly schema = accessTokenSchema
  static override readonly model = AccessToken

  /**
   * Mint a fresh token and persist its hash. Returns the plaintext +
   * the persisted row. Caller shows the plaintext to the user; subsequent
   * requests use it to authenticate.
   */
  async createToken(
    userId: string,
    name: string,
    options: CreateTokenOptions = {},
  ): Promise<MintedToken> {
    const id = ulid()
    const secret = randomToken(SECRET_BYTES)
    const plaintext = `${id}${TOKEN_SEPARATOR}${secret}`
    const hash = sha256(secret)
    const expires_at =
      options.expiresInSeconds == null
        ? null
        : new Date(Date.now() + options.expiresInSeconds * 1000)

    const model = await this.create({
      id,
      user_id: userId,
      name,
      hash,
      expires_at,
    } as Partial<AccessToken>)

    return { plaintext, model }
  }

  /**
   * Look up the row corresponding to a plaintext token + verify the secret
   * half. Constant-time hash compare; returns `null` for any of:
   *   - malformed token (no separator)
   *   - id half references no row
   *   - secret half hashes to something other than the stored hash
   *   - row is expired (`expires_at <= now`)
   */
  async findByPlaintext(plaintext: string, now: Date = new Date()): Promise<AccessToken | null> {
    const sep = plaintext.indexOf(TOKEN_SEPARATOR)
    if (sep <= 0 || sep === plaintext.length - 1) return null

    const id = plaintext.slice(0, sep)
    const secret = plaintext.slice(sep + 1)
    const row = await this.find(id)
    if (!row) return null
    if (!constantTimeEqual(row.hash, sha256(secret))) return null
    if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) return null
    return row
  }

  /** Bulk revoke every token for a user. Returns the affected row count. */
  async revokeAllForUser(userId: string): Promise<number> {
    const sql = `DELETE FROM ${quoteIdent(accessTokenSchema.name)} WHERE ${quoteIdent('user_id')} = $1`
    return this.db.execute(sql, [userId])
  }
}
