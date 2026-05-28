/**
 * `AccessToken` — the typed row of the `access_token` table.
 *
 * One row per active bearer token. The caller never sees the row's
 * `hash`; the plaintext is returned exactly once by
 * `AccessTokenRepository.createToken()`.
 */

import { hidden, Model } from '@strav/database'
import { accessTokenSchema } from './access_token_schema.ts'

export class AccessToken extends Model {
  static override readonly schema = accessTokenSchema

  id!: string
  user_id!: string
  name!: string
  /**
   * SHA-256 of the secret half of the token. Marked `@hidden` so
   * `JSON.stringify(token)` doesn't leak it — API responses returning a
   * token row (e.g. token-list endpoints) would otherwise reveal the
   * stored hash, which is a credential.
   */
  @hidden hash!: string
  expires_at!: Date | null
  created_at!: Date
  updated_at!: Date

  /** True when `expires_at` is null (never expires) or in the future. */
  isValid(now: Date = new Date()): boolean {
    return this.expires_at === null || this.expires_at.getTime() > now.getTime()
  }
}
