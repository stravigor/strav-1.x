# Facebook Login

Facebook fills the gap when Line + Google don't — typical for B2C apps in Indonesia, Philippines, Vietnam, and global non-Google markets. The driver is plain OAuth2 (no OIDC) with some Facebook-specific quirks.

## Configure

```ts
// config/social.ts
providers: {
  facebook: {
    driver: 'facebook',
    clientId: env('FACEBOOK_APP_ID'),
    clientSecret: env('FACEBOOK_APP_SECRET'),
    graphVersion: 'v18.0',  // default; bump explicitly when migrating
  },
}
```

Get credentials from [Meta for Developers](https://developers.facebook.com) → My Apps → Facebook Login product → Settings.

```ts
import { FacebookSocialProvider } from '@strav/social/facebook'

export default [
  // …,
  FacebookSocialProvider,
]
```

## Sign-in flow

```ts
// 1. Start
const { url, state, codeVerifier } = await social.use('facebook').authorize({
  redirectUri: 'https://app.example.com/auth/facebook/callback',
  scopes: ['public_profile', 'email'],
})
session.put({ fbState: state, fbCodeVerifier: codeVerifier })
return Response.redirect(url, 303)

// 2. Callback
const tokens = await social.use('facebook').exchange({
  code: req.query.code,
  state: req.query.state,
  expectedState: session.get('fbState'),
  redirectUri: 'https://app.example.com/auth/facebook/callback',
  codeVerifier: session.get('fbCodeVerifier'),
})

// 3. Profile from Graph /me
const profile = await social.use('facebook').profile(tokens.accessToken)
```

## Two real divergences from Line / Google

### 1. No `refresh_token`

Facebook hands out short-lived access tokens (~1–2h) and a separate "long-lived token" path that swaps the access token itself for a ~60-day variant. That's not a refresh-token grant in the framework's contract sense.

The driver's `refresh()` **throws** `ProviderUnsupportedError`. For long-lived tokens, use the Facebook-specific helper:

```ts
import type { FacebookSocialDriver } from '@strav/social/facebook'

const driver = social.use('facebook') as FacebookSocialDriver
const longLived = await driver.exchangeForLongLivedToken(tokens.accessToken)
// store longLived.accessToken; valid for ~60 days
```

Apps that need offline access beyond 60 days require the user to re-sign-in. There is no equivalent of Google's permanent refresh token.

### 2. `email` scope needs App Review

The `email` scope works in test mode (developer + tester users only) without review. To request it from production users, you go through [Meta's App Review](https://developers.facebook.com/docs/app-review). Until then, your prod users get a sign-in that returns no email.

The capability flag `profile.email` is declared by the driver — apps gate the scope picker UI based on their own deployment state, not just the flag.

## Capability matrix

| Capability | Supported |
|---|---|
| openid | ✗ — plain OAuth2 |
| pkce.support | ✓ (default-on) |
| profile.id / email / name / avatar / locale | ✓ |
| profile.emailVerified | ✗ — Facebook doesn't assert |
| tokens.exchange | ✓ |
| tokens.refresh | ✗ — use `exchangeForLongLivedToken` |
| tokens.revoke | ✓ (clears ALL scopes) |
| tokens.introspect | ✓ (via Graph `/debug_token`) |
| scopes.discoverable | ✓ |

## Picture flattening

Facebook returns `picture` as `{ data: { url, is_silhouette, ... } }` — the driver flattens to a flat `avatarUrl` string and stashes `is_silhouette` in metadata.

## Profile fields

The driver passes a default `fields=` list to `/me`: `id, name, email, first_name, last_name, picture.type(large), locale`. Override via config:

```ts
{
  driver: 'facebook',
  // …,
  profileFields: ['id', 'name', 'email', 'birthday', 'gender'],
}
```

Note: many fields (birthday, gender, age range) require their own Meta App Review approval.

## Token introspection

```ts
const driver = social.use('facebook') as FacebookSocialDriver
const result = await driver.debugToken(userToken)
// result.data.is_valid, .expires_at, .scopes, .user_id
```

The driver composes the app-token (`client_id|client_secret`) for the call automatically.

## Revoke

```ts
await social.use('facebook').revoke(tokens.accessToken)
```

`DELETE /me/permissions` — clears **every scope** the user granted to your app, not just the one you're targeting. Per-scope revoke isn't bridged; apps that need finer control call the Graph API directly.
