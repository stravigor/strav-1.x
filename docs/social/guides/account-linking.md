# Account linking

After `authorize → exchange → profile`, you have a verified OAuth identity. The app's job is two-fold:

1. **Sign in** an existing user — find which user owns this identity.
2. **Link** a new identity to either a new or existing user.

`@strav/social`'s ledger handles both with one upsert call.

## The four operations

```ts
import { SocialAccountRepository } from '@strav/social'

// 1. Sign-in lookup: who owns this OAuth identity?
const existing = await accounts.findByProviderIdentity('line', profile.id)
if (existing) {
  // returning user — `existing.user_id` is your app's user id
  return loginUser(existing.user_id)
}

// 2. Connect (upsert): first-time link OR token refresh on re-sign-in
const account = await accounts.connect({
  userId: user.id,
  provider: 'line',
  profile,    // SocialProfile from `social.use('line').profile(...)`
  tokens,     // OAuthTokens from `social.use('line').exchange(...)`
})

// 3. Disconnect (unlink)
await accounts.disconnect({ userId: user.id, provider: 'line' })

// 4. Account settings UI — every provider linked to this user
const linked = await accounts.findByUser(user.id)
// → [{ provider: 'line', name: 'Liva', avatar_url: '…', … }, …]
```

## The full sign-in handler

```ts
const tokens = await social.use('line').exchange({…})
const profile = await social.use('line').profile(tokens.accessToken)

const existing = await accounts.findByProviderIdentity('line', profile.id)
if (existing) {
  // Returning user — refresh tokens + cached profile fields.
  await accounts.connect({
    userId: existing.user_id,
    provider: 'line',
    profile,
    tokens,
  })
  return loginUser(existing.user_id)
}

// New identity — branch on email match (or other app logic).
if (profile.email) {
  const user = await users.findByEmail(profile.email)
  if (user) {
    // Link to existing user.
    await accounts.connect({ userId: user.id, provider: 'line', profile, tokens })
    return loginUser(user.id)
  }
}

// True sign-up — create user, then link.
const user = await users.create({ email: profile.email, name: profile.name })
await accounts.connect({ userId: user.id, provider: 'line', profile, tokens })
return loginUser(user.id)
```

## Cross-user link guard

If an OAuth identity is already linked to user A and user B tries to link the same identity, `connect()` throws `SocialAccountAlreadyLinkedError`:

```ts
try {
  await accounts.connect({ userId: 'user_b', provider: 'line', profile, tokens })
} catch (err) {
  if (err instanceof SocialAccountAlreadyLinkedError) {
    return errorPage({
      message: `That Line account is already linked to another user (${err.existingUserId}).`,
      action: 'sign in with that account instead, or unlink it from the other user first.',
    })
  }
  throw err
}
```

Apps that want to **move** a link rather than refuse it call `disconnect` on the old user first, then `connect` on the new one. The framework refuses to silently overwrite.

## Encrypted-at-rest tokens

The schema declares `access_token`, `refresh_token`, and `id_token` as `t.encrypted(...)` columns (Postgres `bytea`). The Model marks them `@encrypt`. The Repository transparently encrypts on write and decrypts on hydration via `@strav/kernel`'s `Cipher`.

**Requirement**: register `EncryptionProvider` in your bootstrap. Without it, the first `connect()` call throws `ConfigError` at runtime.

```ts
// config/encryption.ts
export default {
  key: env('ENCRYPTION_KEY'),  // 32 random bytes, hex or base64
}

// bootstrap/providers.ts
import { EncryptionProvider } from '@strav/kernel'
export default [
  ConfigProvider,
  LoggerProvider,
  EncryptionProvider,    // ← before DatabaseProvider + SocialProvider
  DatabaseProvider,
  SocialProvider,
  LineSocialProvider,
  // …
]
```

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The key MUST stay stable across restarts; rotating means re-encrypting every existing row. Store it in a secret manager — never the repo.

## Migration

```ts
import { applySocialAccountMigration } from '@strav/social'

export const migration: Migration = {
  name: '20260601000000_create_social_account',
  async up(db) {
    await applySocialAccountMigration(db, { registry })
  },
}
```

Creates one table — `social_account` — with three indexes:

| Index | Purpose |
|---|---|
| `idx_social_account_provider_identity` UNIQUE `(provider, provider_user_id)` | Sign-in lookup + cross-user link guard |
| `idx_social_account_user_provider` UNIQUE `(user_id, provider)` | One link per user-per-provider |
| `idx_social_account_user` `(user_id)` | "All accounts for this user" |

**Non-tenanted by default** — framework policy is opt-in multitenancy. See [multi-tenancy.md](./multi-tenancy.md) for the tenanted variant.

## What lives where

| Column | Source |
|---|---|
| `user_id` | App's user reference (free-form string — ULID / int / uuid all fit) |
| `provider` | Driver instance name (`'line'` / `'google'` / `'facebook'` / custom) — distinct from `profile.provider` when one driver is wired under multiple instances |
| `provider_user_id` | `profile.id` — provider-native subject id |
| `email`, `name`, `avatar_url`, `locale` | Cached from `profile` — apps render UI from these without re-fetching |
| `access_token`, `refresh_token`, `id_token` | Encrypted; hydrate to plaintext in memory |
| `expires_at`, `scope` | From `tokens.expiresAt` / `tokens.scope` — useful for proactive refresh |
| `metadata` | Free-form jsonb — driver/provider extras (Line's `statusMessage`, Facebook's `is_silhouette`, etc.) |

## "Did this user link X provider?" pattern

```ts
const account = await accounts.findByUserAndProvider(user.id, 'line')
const hasLine = account !== null
const lineEmail = account?.email
```

## Refresh tokens proactively

```ts
const account = await accounts.findByUserAndProvider(user.id, 'google')
if (account?.refresh_token && account.expires_at && account.expires_at < new Date()) {
  const refreshed = await social.use('google').refresh({
    refreshToken: account.refresh_token,
  })
  // Re-upsert to persist the new access_token.
  await accounts.connect({
    userId: user.id,
    provider: 'google',
    profile: { id: account.provider_user_id, provider: 'google', metadata: {}, raw: null },
    tokens: refreshed,
  })
}
```

(Apps usually wrap this in a "get fresh access token for X provider" helper.)
