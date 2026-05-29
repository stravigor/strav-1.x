# Line Login

Line is SEA-load-bearing — dominant chat + login surface in Thailand and Japan, with growing reach in Indonesia and Taiwan. Strav defaults to Line as the primary social adapter.

## Configure

```ts
// config/social.ts
export default {
  default: 'line',
  providers: {
    line: {
      driver: 'line',
      clientId: env('LINE_CLIENT_ID'),         // Channel ID
      clientSecret: env('LINE_CLIENT_SECRET'),  // Channel secret
      uiLocales: 'th-TH',                       // optional; passed on every authorize
    },
  },
}
```

Get credentials from [https://developers.line.biz/console](https://developers.line.biz/console) — a Line Login channel under a provider.

```ts
import { SocialProvider } from '@strav/social'
import { LineSocialProvider } from '@strav/social/line'

export default [
  ConfigProvider, LoggerProvider, EncryptionProvider, DatabaseProvider,
  SocialProvider,
  LineSocialProvider,
  // ...
]
```

## Sign-in flow

```ts
import { SocialManager } from '@strav/social'
import { emailFromLineIdToken } from '@strav/social/line'

// 1. Start
const { url, state, codeVerifier } = await social.use('line').authorize({
  redirectUri: 'https://app.example.com/auth/line/callback',
  scopes: ['openid', 'profile', 'email'],
})
session.put({ lineState: state, lineCodeVerifier: codeVerifier })
return Response.redirect(url, 303)

// 2. Callback
const tokens = await social.use('line').exchange({
  code: req.query.code,
  state: req.query.state,
  expectedState: session.get('lineState'),
  redirectUri: 'https://app.example.com/auth/line/callback',
  codeVerifier: session.get('lineCodeVerifier'),
})

// 3. Profile — note that Line does NOT include email on /v2/profile.
//    Decode the id_token if you need it (only present when `openid email`
//    was requested AND granted).
const profile = await social.use('line').profile(tokens.accessToken)
if (tokens.idToken && !profile.email) {
  profile.email = emailFromLineIdToken(tokens.idToken) ?? undefined
}
```

## Scope nuances

| Scope | What you get |
|---|---|
| `profile` | userId + displayName + pictureUrl (always available — no approval needed) |
| `openid` | id_token JWT (free — request `'openid profile'`) |
| `email` | email claim inside the id_token. Requires the "email permission" toggle on the channel (Line approval before production) |

For the **email** scope: request it from your channel's settings in the Line console first. Until granted, requests succeed but the id_token won't include the email claim.

## Capability matrix

| Capability | Supported |
|---|---|
| openid | ✓ |
| pkce.support | ✓ (default-on) |
| profile.id / name / avatar / email / emailVerified | ✓ |
| profile.locale | ✗ — not on `/v2/profile` |
| tokens.exchange / refresh / revoke / introspect | ✓ |
| scopes.discoverable | ✓ |

## PKCE default-on

The driver defaults to including PKCE on the authorize URL (defence in depth for callback hijacking on mobile / SPA flows). Server-side flows ignore the verifier safely. To opt out — rare; you almost certainly shouldn't — pass `extra: { no_pkce: '1' }` on authorize.

## Line-specific extras

Pass via `authorize({ extra: {...} })`:

| Param | What it does |
|---|---|
| `bot_prompt` | `'normal'` or `'aggressive'` — controls the Bot Link prompt during consent |
| `ui_locales` | Per-call override of the config-level default (`'th-TH'`, `'ja-JP'`, …) |
| `prompt` | `'consent'` forces re-consent (re-establish refresh tokens after revoke) |

## Webhook events

Line doesn't push OAuth events back to your server — sign-in is request/response only. Long-running session validity is tracked via the access token's `expires_at` field; refresh proactively before that hits.

## Raw client access

The driver's `fetch` is `config.fetch ?? globalThis.fetch`. There's no SDK to drop down to — every Line operation we don't wrap is just a `fetch` to the documented endpoint. Add a small wrapper inside your app if you need behaviour the framework doesn't surface (e.g. `/v2/profile/friends` for friends list once the user grants the scope).

## Webhook events handled (none in v1)

Line OAuth itself doesn't have a webhook event stream — bot-side Line Messaging API has webhooks, but those are out of scope for `@strav/social`. Apps that build chat experiences combine `@strav/social/line` (sign-in) with a separate Line Messaging integration.
