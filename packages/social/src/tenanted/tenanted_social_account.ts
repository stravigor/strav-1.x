/**
 * `TenantedSocialAccount` — typed row of the opt-in tenanted
 * ledger. Identical to `SocialAccount` except its `static schema`
 * points at the tenanted variant, so the Repository runs against
 * the right DDL + RLS policy.
 */

import { encrypt, Model } from '@strav/database'
import { tenantedSocialAccountSchema } from './tenanted_social_account_schema.ts'

export class TenantedSocialAccount extends Model {
  static override readonly schema = tenantedSocialAccountSchema

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
