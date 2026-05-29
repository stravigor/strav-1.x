# State + PKCE management

The OAuth callback is the moment where security goes wrong if you wave hands. The driver does its half (generating + verifying); your app does the other half (persisting state across the redirect).

## The two artefacts you persist

After `authorize(...)`, the result carries up to two values you have to store somewhere keyed to the user's session:

```ts
const { url, state, codeVerifier } = await social.use('line').authorize({
  redirectUri: 'https://app.example.com/auth/line/cb',
  scopes: ['openid', 'profile'],
})
```

| Field | Purpose | Length |
|---|---|---|
| `state` | CSRF token. Returned by the provider on the callback; you verify it matches. | ~43 chars (32 bytes base64url) |
| `codeVerifier` | PKCE verifier. Sent back to the token endpoint; the provider hashes and compares against the challenge it stored. | 64 chars |

Both must survive the redirect round-trip. The cleanest storage is the user's signed session cookie.

## Recommended pattern

```ts
// /auth/line/start
const { url, state, codeVerifier } = await social.use('line').authorize({
  redirectUri: callbackUrl,
  scopes: ['openid', 'profile', 'email'],
})
session.put({
  lineState: state,
  ...(codeVerifier ? { lineCodeVerifier: codeVerifier } : {}),
})
return Response.redirect(url, 303)

// /auth/line/cb
const { code, state: returnedState } = url.searchParams
const tokens = await social.use('line').exchange({
  code,
  state: returnedState,
  expectedState: session.get('lineState'),
  redirectUri: callbackUrl,
  codeVerifier: session.get('lineCodeVerifier'),
})
session.forget(['lineState', 'lineCodeVerifier'])
```

Clean up after exchange — these are single-use; lingering values are a code smell.

## Why both?

`state` protects against CSRF (an attacker can't initiate a flow with a code that maps to your session). PKCE protects against **code interception** — even if an attacker grabs the authorization code mid-flight (mobile deep-link hijack, log leak, etc.), they can't redeem it without the verifier you privately kept.

For server-side apps where the client_secret is genuinely secret, PKCE is belt-and-braces. Strav's drivers default it on anyway because the OAuth 2.1 trajectory is "PKCE for everyone" and it's near-free to add.

## Opting out of PKCE

Pass `extra: { no_pkce: '1' }` on authorize. The helper is stripped before sending to the provider. Strongly recommended against — there's no upside.

## Custom state (e.g. session-bound nonce)

If you already have a CSRF-safe per-session nonce, pass it as `state`:

```ts
const sessionNonce = session.get('csrfNonce')
const { url } = await social.use('line').authorize({
  redirectUri: callbackUrl,
  state: sessionNonce,
})
// no need to store state separately
```

The driver echoes it on the result; the provider returns it on callback; you compare against `session.get('csrfNonce')`.

## State store alternatives

If session cookies don't fit (single-page apps, IoT, etc.), you can store state server-side:

- **Database** — short-lived rows keyed by `state`. Garbage-collect after 10 minutes.
- **Redis / cache** — same idea with TTL.
- **Signed JWT in URL** — embed `(state, codeVerifier, returnTo)` as a JWT in the `state` param itself. The provider treats it as opaque. You verify on callback.

The framework doesn't ship a state store in v1 — patterns vary too much. Bring your own.

## Error paths

| Error | What it means | Action |
|---|---|---|
| `StateMismatchError` | `state` returned ≠ `expectedState` | Don't process. Strong CSRF signal. Log + bounce to login. |
| `OAuthExchangeError` | Provider rejected the code (expired, already used, wrong client) | Code is single-use; user retry. |
| `InvalidTokenError` | Token endpoint returned 400/401 on refresh, or profile / userinfo returned 401 | Token is dead; force re-sign-in. |

```ts
try {
  const tokens = await social.use('line').exchange({ … })
} catch (err) {
  if (err instanceof StateMismatchError) {
    return loginPage({ flash: 'Sign-in failed — please try again.' })
  }
  if (err instanceof OAuthExchangeError) {
    return loginPage({ flash: 'Sign-in link expired.' })
  }
  throw err
}
```
