/**
 * `SocialAccount` — typed row of the linked-provider ledger.
 *
 * `@encrypt` on the token fields tells the Repository to wrap
 * them through the registered `EncryptionProvider` on
 * write/read. In memory they are plain strings; on disk they
 * are bytea.
 */

import { encrypt, Model } from '@strav/database'
import { socialAccountSchema } from './social_account_schema.ts'

export class SocialAccount extends Model {
  static override readonly schema = socialAccountSchema

  id!: string
  user_id!: string
  provider!: string
  provider_user_id!: string
  email!: string | null
  name!: string | null
  avatar_url!: string | null
  locale!: string | null
  @encrypt access_token!: string
  @encrypt refresh_token!: string | null
  @encrypt id_token!: string | null
  expires_at!: Date | null
  scope!: string | null
  metadata!: Record<string, unknown>
  created_at!: Date
  updated_at!: Date
}
