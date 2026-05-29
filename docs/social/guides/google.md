# Google Sign-In

Google is the international-reach option — most B2B + cross-region B2C apps end up needing it. Strav's Line-first default doesn't preclude Google; multi-provider apps register both.

## Configure

```ts
// config/social.ts
export default {
  default: 'line',  // or 'google' if Google is your primary
  providers: {
    google: {
      driver: 'google',
      clientId: env('GOOGLE_CLIENT_ID'),         // …apps.googleusercontent.com
      clientSecret: env('GOOGLE_CLIENT_SECRET'), // GOCSPX-…
      offlineAccess: true,  // default — required for refresh tokens
    },
  },
}
```

Get credentials from [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → OAuth 2.0 Client IDs → **Web application** type.

```ts
import { SocialProvider } from '@strav/social'
import { GoogleSocialProvider } from '@strav/social/google'

export default [
  ConfigProvider, LoggerProvider, EncryptionProvider, DatabaseProvider,
  SocialProvider,
  GoogleSocialProvider,
  // ...
]
```

## Sign-in flow

```ts
// 1. Start
const { url, state, codeVerifier } = await social.use('google').authorize({
  redirectUri: 'https://app.example.com/auth/google/callback',
  scopes: ['openid', 'profile', 'email'],
})
session.put({ googleState: state, googleCodeVerifier: codeVerifier })
return Response.redirect(url, 303)

// 2. Callback
const tokens = await social.use('google').exchange({
  code: req.query.code,
  state: req.query.state,
  expectedState: session.get('googleState'),
  redirectUri: 'https://app.example.com/auth/google/callback',
  codeVerifier: session.get('googleCodeVerifier'),
})

// 3. Profile — Google's /v1/userinfo returns email, email_verified, locale
const profile = await social.use('google').profile(tokens.accessToken)
```

## Refresh tokens

Google issues a `refresh_token` **only when** `access_type=offline` is set (default on) AND it's the user's first consent. Subsequent sign-ins return tokens with no `refresh_token`. To re-establish offline access after revocation, force re-consent:

```ts
await social.use('google').authorize({
  redirectUri: '…',
  extra: { prompt: 'consent' },
})
```

The driver's `refresh()` **preserves the caller's refresh token** when Google's response omits one — important because Google doesn't rotate. If you drop the original on a refresh response, you'd lose offline access permanently.

## Workspace (`hd`) domain constraint

For Google Workspace apps that only accept one domain:

```ts
await social.use('google').authorize({
  redirectUri: '…',
  extra: { hd: 'example.com' },
})
```

## Capability matrix

| Capability | Supported |
|---|---|
| openid | ✓ |
| pkce.support | ✓ (default-on; mandatory for SPA / installed client types — the driver's "Web application" mode treats it as optional but defaults it on for defence in depth) |
| profile.id / email / emailVerified / name / avatar / locale | ✓ |
| tokens.exchange / refresh / revoke / introspect | ✓ |
| scopes.discoverable | ✓ |

Full set.

## Progressive scope grants

`include_granted_scopes=true` is on by default — Google merges previous grants with the current request instead of replacing. Apps that incrementally request scopes (e.g. start with `profile`, ask for `email` later) benefit without configuration.

## Common extras

| Param | What it does |
|---|---|
| `prompt` | `'consent'` (force re-consent), `'select_account'` (force account picker) |
| `hd` | Workspace hosted domain constraint |
| `login_hint` | Pre-fill the email field on the picker |
| `access_type` | Already default `'offline'` via `offlineAccess`; explicit `'online'` overrides |
