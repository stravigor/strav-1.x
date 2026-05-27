/**
 * `Session` — the typed row of the `session` table.
 *
 * One session per active login. The `id` is what lives in the cookie;
 * everything else describes the session's state for the framework's
 * lookup + expiry logic. The plain object shape (no methods beyond what
 * Model provides) keeps it cheap to instantiate during hydration.
 */

import { Model } from '@strav/database'
import { sessionSchema } from './session_schema.ts'

export class Session extends Model {
  static override readonly schema = sessionSchema

  id!: string
  user_id!: string
  expires_at!: Date
  created_at!: Date
  updated_at!: Date

  /** True when the session's `expires_at` is in the future. */
  isValid(now: Date = new Date()): boolean {
    return this.expires_at.getTime() > now.getTime()
  }
}
