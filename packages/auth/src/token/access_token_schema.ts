/**
 * `accessTokenSchema` — the Schema for the `access_token` table.
 *
 * Token storage model: the plaintext is split into `<row_id>|<secret>`.
 * The row PK is what we look up by; only the SHA-256 of the secret is
 * stored. So:
 *   - id          ULID PK. First half of the plaintext token (cleartext
 *                 on the wire, fine — it's a public identifier).
 *   - user_id     The auth identifier the token grants access for.
 *   - name        Human label ("CI deploy key", "Personal API token") —
 *                 surfaced in account-management UIs.
 *   - hash        Hex-encoded SHA-256 of the secret half. Verified by
 *                 constant-time compare in `findByPlaintext`. Indexed
 *                 implicitly by the unique constraint isn't worth the
 *                 lookup cost (we look up by id) — left non-unique.
 *   - expires_at  Nullable. NULL = never expires (the framework allows
 *                 it; apps can require expiry via FormRequest rules).
 *   - timestamps  created_at + updated_at.
 *
 * Not in V1 (each lands as its own slice):
 *   - `abilities` jsonb — scope/permission tags. Lands with the auth
 *     policies slice; today every token has full access.
 *   - `last_used_at` timestamptz — useful for audit + "kill unused
 *     tokens" cleanup, but writing on every authenticate is
 *     prohibitively expensive without batching. Lands with a
 *     write-batching slice.
 */

import { Archetype, defineSchema } from '@strav/database'

export const accessTokenSchema = defineSchema('access_token', Archetype.Entity, (t) => {
  t.id()
  t.string('user_id').max(64).notNull()
  t.string('name').max(64).notNull()
  t.string('hash').max(64).notNull()
  t.timestamp('expires_at').nullable()
  t.timestamps()
})
