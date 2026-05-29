import { Archetype, defineSchema } from '@strav/database'

/**
 * `strav_magic_links` — single-use signed tokens for passwordless sign-in.
 *
 * `token` is a random 32-byte hex string (64 chars) — stored as plaintext
 * because the security guarantee is single-use + short TTL, not secrecy of
 * the token itself (it's sent over email, which is the trust boundary).
 * Apps that want extra hardening can SHA-256 hash the stored value.
 *
 * `used_at` is NULL until the link is consumed, then filled with now().
 * Consumed links are kept for an audit window; apps prune them with a
 * scheduled `magic:prune` command or a DB CRON.
 */
export const magicLinkSchema = defineSchema('strav_magic_links', Archetype.Event, (t) => {
  t.id()
  t.string('user_id').max(26) // FK to the app's user table — string to match ULID PKs
  t.string('token').max(64).unique()
  t.string('redirect_to').max(2048).nullable()
  t.timestamp('expires_at')
  t.timestamp('used_at').nullable()
  t.timestamps()
})
