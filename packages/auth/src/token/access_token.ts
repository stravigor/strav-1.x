/**
 * `AccessToken` — the typed row of the `access_token` table.
 *
 * One row per active bearer token. The caller never sees the row's
 * `hash`; the plaintext is returned exactly once by
 * `AccessTokenRepository.createToken()`.
 */

import { Model } from '@strav/database'
import { accessTokenSchema } from './access_token_schema.ts'

export class AccessToken extends Model {
  static override readonly schema = accessTokenSchema

  id!: string
  user_id!: string
  name!: string
  hash!: string
  expires_at!: Date | null
  created_at!: Date
  updated_at!: Date

  /** True when `expires_at` is null (never expires) or in the future. */
  isValid(now: Date = new Date()): boolean {
    return this.expires_at === null || this.expires_at.getTime() > now.getTime()
  }
}
