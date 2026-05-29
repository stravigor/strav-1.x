/**
 * `socialAccountSchema` — ledger of provider identities linked
 * to app users. **Non-tenanted by default** (framework policy:
 * multitenancy is opt-in). Apps that need per-tenant scoping
 * import `tenantedSocialAccountSchema` from
 * `@strav/social/tenanted` instead.
 *
 * Natural key is `(provider, provider_user_id)` — a given
 * Google / Line / Facebook identity belongs to exactly one
 * user. Composite uniqueness lives in the migration (the schema
 * builder only exposes per-column `.unique()`).
 *
 * Tokens are encrypted-at-rest via `@strav/database`'s
 * `t.encrypted(...)` column kind + `@encrypt` decorator on the
 * Model. Apps must have an `EncryptionProvider` registered on
 * the kernel container; otherwise the first repository call
 * throws `ConfigError` at runtime.
 *
 * Why store tokens here at all: many apps need long-term
 * offline access (Google `access_type=offline`) or to revoke
 * later. Apps that only need "did this user sign in via X"
 * set the encrypted columns to a sentinel via the Repository's
 * upsert path and discard the real tokens after first use.
 *
 * Columns:
 *
 *   - `id`                 ULID PK.
 *   - `user_id`            App-side user reference. Free-form
 *                          string so apps with ULID / int / uuid
 *                          PKs all fit.
 *   - `provider`           Driver identifier (`'line'` /
 *                          `'google'` / `'facebook'` / custom).
 *   - `provider_user_id`   Provider-native subject id (Google
 *                          `sub`, Line `userId`, Facebook `id`).
 *   - `email`              Last known email — cached for app
 *                          UI; canonical lookups go to the user.
 *   - `name`               Last known display name.
 *   - `avatar_url`         Last known avatar URL.
 *   - `locale`             Last known locale (where the provider
 *                          gives one; Line doesn't).
 *   - `access_token`       Encrypted-at-rest.
 *   - `refresh_token`      Encrypted-at-rest. Nullable (Facebook
 *                          doesn't issue them).
 *   - `id_token`           Encrypted-at-rest. Nullable (OIDC
 *                          providers only).
 *   - `expires_at`         When the access token expires.
 *   - `scope`              Space-separated granted scope string.
 *   - `metadata`           Free-form jsonb (provider extras).
 *   - `created_at` / `updated_at`
 */

import { Archetype, defineSchema } from '@strav/database'

export const socialAccountSchema = defineSchema(
  'social_account',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('user_id').max(64).notNull()
    t.string('provider').max(64).notNull()
    t.string('provider_user_id').max(255).notNull()
    t.string('email').max(320).nullable()
    t.string('name').max(255).nullable()
    t.string('avatar_url').max(1024).nullable()
    t.string('locale').max(16).nullable()
    t.encrypted('access_token').notNull()
    t.encrypted('refresh_token').nullable()
    t.encrypted('id_token').nullable()
    t.timestamp('expires_at').nullable()
    t.string('scope').max(512).nullable()
    t.json('metadata').notNull().default({})
    t.timestamp('created_at').notNull()
    t.timestamp('updated_at').notNull()
  },
)
