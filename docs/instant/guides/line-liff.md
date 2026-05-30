# LINE — LIFF ID-token verification

LIFF (LINE Front-end Framework) lets you embed a web app inside LINE's in-app browser. The frontend gets an ID token from LINE via `liff.getIDToken()`; the backend must verify that token before trusting any user identity claim it carries.

**Never trust a `userId` posted directly from a LIFF frontend without verifying the ID token first.** A user can edit any value the client sends; only LINE's signature on the JWT guarantees identity.

## Setup — two channels, not one

LINE separates the bot surface across two channels in the Developers Console, and LIFF lives on the **second** one:

1. **Messaging API channel** — issues `channelAccessToken` + `channelSecret`. Used by `send`, `reply`, webhook verification. Has its own channel id, which is **not** what we want here.
2. **LINE Login channel** — a separate channel under the same provider. LIFF apps are registered under this channel. The `aud` claim on every LIFF ID token is *this* channel's id.

Set `liff.channelId` to the **LINE Login channel id**. Copying the Messaging API channel id into this slot is the single most common misconfiguration and will fail every verify call with an `aud` mismatch.

```ts
// config/instant.ts
export default {
  default: 'line',
  providers: {
    line: {
      driver: 'line',
      // Messaging API channel — for send / reply / webhook:
      channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN'),
      channelSecret:      env('LINE_CHANNEL_SECRET'),
      // LINE Login channel — for LIFF ID-token verification.
      // Get this from the LOGIN channel's "Basic settings" tab,
      // NOT the Messaging API channel.
      liff: { channelId: env('LINE_LOGIN_CHANNEL_ID') },
    },
  },
}
```

## Verify a token

```ts
router.post('/liff/session', async (ctx) => {
  const { idToken } = await ctx.request.json<{ idToken: string }>()
  const liff = ctx.app.resolve(InstantManager).use('line').liff

  const claims = await liff.verifyIdToken(idToken)
  // claims.sub === LINE userId
  // claims.name, claims.picture, claims.email (when scope granted)

  const session = await createSession(claims.sub, {
    name:    claims.name,
    picture: claims.picture,
    email:   claims.email,
  })
  return ctx.response.json({ token: session.token })
})
```

`verifyIdToken` POSTs to `https://api.line.me/oauth2/v2.1/verify`, which validates the signature, audience, and expiry. It throws `InstantProviderError` on any failure (expired, tampered, wrong audience, network error) — let your default exception handler return 401.

## Optional checks

`verifyIdToken` accepts a second options arg:

```ts
await liff.verifyIdToken(idToken, {
  nonce:  'value-the-frontend-sent',  // LINE will reject if mismatched
  userId: 'Uknown-user-id',           // shortcut for matching against `sub`
})
```

Use `nonce` to bind the token to a single sign-in attempt (mitigates replay).

## Where LINE Login lives

LIFF *only* gives you ID tokens for users who already signed into LINE on their device — there's no separate OAuth flow to run. If your app needs **LINE as a federated login provider for non-LIFF surfaces** (regular web sign-in via a browser), use `@strav/social`'s LINE provider instead. The two packages cover different cases:

| Surface | Package | Why |
|---|---|---|
| LIFF webview backend | `@strav/instant/line` | LINE issues ID tokens client-side; backend verifies. No OAuth round-trip. |
| Web "Login with LINE" button | `@strav/social` | Full OAuth/OIDC authorization code flow. |
