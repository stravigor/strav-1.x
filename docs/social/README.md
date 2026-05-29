# @strav/social

Provider-agnostic OAuth / OIDC client for social sign-in. One fluent surface (`social.authorize`, `social.exchange`, `social.profile`, `social.refresh`, `social.revoke`) routes into Line, Google, or Facebook. Apps that route across providers branch on capability.

```ts
import { SocialManager } from '@strav/social'

const social = container.resolve(SocialManager)

// 1. Start a Line sign-in
const { url, state, codeVerifier } = await social.use('line').authorize({
  redirectUri: 'https://app.example.com/auth/line/callback',
  scopes: ['openid', 'profile', 'email'],
})
session.put({ socialState: state, socialCodeVerifier: codeVerifier })
return Response.redirect(url, 303)

// 2. Callback handler
const tokens = await social.use('line').exchange({
  code: req.query.code,
  state: req.query.state,
  expectedState: session.get('socialState'),
  redirectUri: 'https://app.example.com/auth/line/callback',
  codeVerifier: session.get('socialCodeVerifier'),
})
const profile = await social.use('line').profile(tokens.accessToken)

// 3. Link to a user record
await socialAccounts.connect({
  userId: user.id,
  provider: 'line',
  profile,
  tokens,
})
```

## What ships in v1

| Surface | Where |
|---|---|
| Core abstraction: manager, normalized DTOs, errors, capabilities, PKCE + state helpers, mock driver | `@strav/social` |
| Line Login v2.1 — SEA-first regional default | `@strav/social/line` |
| Google Sign-In (OAuth 2.0 + OIDC) | `@strav/social/google` |
| Facebook Login (Graph API) | `@strav/social/facebook` |
| Account-linking ledger (encrypted token storage) | `@strav/social` (default — non-tenanted) |
| Multi-tenant variant | `@strav/social/tenanted` (opt-in) |

## Install

```bash
bun add @strav/social
```

Subpath drivers (`@strav/social/line`, etc.) ship in the same package. No vendor SDKs — drivers talk to provider HTTP endpoints directly via `fetch`.

## Configure

```ts
// config/social.ts
export default {
  default: 'line',  // SEA-first default
  providers: {
    line: {
      driver: 'line',
      clientId: env('LINE_CLIENT_ID'),
      clientSecret: env('LINE_CLIENT_SECRET'),
      uiLocales: 'th-TH',
    },
    google: {
      driver: 'google',
      clientId: env('GOOGLE_CLIENT_ID'),
      clientSecret: env('GOOGLE_CLIENT_SECRET'),
    },
    facebook: {
      driver: 'facebook',
      clientId: env('FACEBOOK_APP_ID'),
      clientSecret: env('FACEBOOK_APP_SECRET'),
    },
  },
}
```

```ts
// bootstrap/providers.ts
import { SocialProvider } from '@strav/social'
import { LineSocialProvider } from '@strav/social/line'
import { GoogleSocialProvider } from '@strav/social/google'
import { FacebookSocialProvider } from '@strav/social/facebook'

export default [
  ConfigProvider, LoggerProvider, EncryptionProvider, DatabaseProvider,
  SocialProvider,
  LineSocialProvider,      // registers `driver: 'line'` factory
  GoogleSocialProvider,
  FacebookSocialProvider,
  // ...
]
```

## Account-linking migration

```ts
import { applySocialAccountMigration } from '@strav/social'

export const migration: Migration = {
  name: '20260601000000_create_social_account',
  async up(db) {
    await applySocialAccountMigration(db, { registry })
  },
}
```

Creates one table — `social_account` — with `(provider, provider_user_id)` and `(user_id, provider)` composite uniques, plus a `user_id` lookup index. **Non-tenanted by default**; apps with multi-tenant data isolation needs use `@strav/social/tenanted`'s variant.

## Capability matrix (high-level)

| | Line | Google | Facebook |
|---|---|---|---|
| `openid` (id_token + JWT) | ✓ | ✓ | ✗ — plain OAuth2 |
| `pkce.support` | ✓ | ✓ | ✓ |
| `profile.email` | ✓ (requires Line approval) | ✓ | ✓ (requires Meta App Review) |
| `profile.emailVerified` | ✓ | ✓ | ✗ — Facebook doesn't assert |
| `profile.locale` | ✗ — not on /v2/profile | ✓ | ✓ |
| `tokens.refresh` | ✓ | ✓ | ✗ — use `exchangeForLongLivedToken` |
| `tokens.revoke` | ✓ | ✓ | ✓ (clears all scopes) |

Apps that build capability-aware UI check `driver.capabilities.has('charges.method.promptpay')`-style flags — the framework refuses to silently emulate.

## Navigation

- [api.md](./api.md) — complete public API reference.
- [guides/line.md](./guides/line.md) — Line Login (SEA-first).
- [guides/google.md](./guides/google.md) — Google Sign-In.
- [guides/facebook.md](./guides/facebook.md) — Facebook Login.
- [guides/account-linking.md](./guides/account-linking.md) — `SocialAccountRepository`, encrypted token storage, cross-user link guard.
- [guides/state-management.md](./guides/state-management.md) — state + PKCE + session storage patterns.
- [guides/multi-tenancy.md](./guides/multi-tenancy.md) — opt-in tenanted variant.
