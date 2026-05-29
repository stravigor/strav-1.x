# Email Verification

Stateless, signed URLs that prove a user owns the email address on file. **No DB table** — the token is `<userId>.<timestamp>.<hmac-sha256>` with `config.app.key` as the secret. Pair with the `'verified'` middleware to gate routes that require a confirmed address.

## Magic links vs. email verification

| | `MagicLinkManager` | `EmailVerification` |
|---|---|---|
| What it proves | Caller owns the email + we should sign them in | Caller owns the email |
| Storage | DB row in `strav_magic_links` | Stateless, signed token |
| Single-use? | Yes (atomic `used_at`) | No (TTL-bounded only) |
| Revocable per-token? | Yes (delete the row) | No (rotate `app.key` to invalidate *all*) |
| Side-effect on success | `ctx.auth.login(user)` | Update `users.email_verified_at` |

Rule of thumb: use **magic links** when clicking the link should sign someone in; use **verification** when clicking the link should *update a column* and continue the normal session.

## Setup

### 1. Config

```ts
// config/app.ts
export default {
  url: process.env.APP_URL,
  key: process.env.APP_KEY,   // 32-byte secret; rotate to invalidate all outstanding tokens
}

// config/auth.ts
export default {
  default: 'session',
  guards: { /* … */ },
  verification: {
    ttlSeconds: 86_400,   // optional; default 24h
    path: '/auth/verify', // optional
  },
}
```

`AuthProvider` resolves `EmailVerification` from these — missing `app.key` throws `ConfigError` at boot.

### 2. User schema

The `verified` middleware reads `ctx.auth.user.email_verified_at`. Add the column to your users schema:

```ts
defineSchema('users', Archetype.Account, (t) => {
  t.id()
  t.string('email').unique()
  // …
  t.timestamp('email_verified_at').nullable()
  t.timestamps()
})
```

### 3. Controller

```ts
// app/http/controllers/email_verification_controller.ts
import type { HttpContext } from '@strav/http'
import { EmailVerification, assertAuth } from '@strav/auth'

export class EmailVerificationController {
  static providers = [EmailVerification]
  constructor(private readonly verifier: EmailVerification) {}

  // POST /auth/verify/resend — auth'd user requests a fresh link
  async resend(ctx: HttpContext) {
    const user = await assertAuth(ctx).userOrFail()
    if (user.email_verified_at) return ctx.response.ok({ alreadyVerified: true })
    const url = this.verifier.signedUrl(user.id)
    await SendVerificationEmail.dispatch({ email: user.email, url })
    return ctx.response.ok({ sent: true })
  }

  // GET /auth/verify/:token — clicked from email
  async verify(ctx: HttpContext) {
    const { userId } = this.verifier.verify(ctx.request.params.token)
    await userRepository.markVerified(userId)  // UPDATE users SET email_verified_at = now()
    return ctx.response.redirect('/dashboard')
  }
}
```

### 4. Routes

```ts
router.post('/auth/verify/resend', [EmailVerificationController, 'resend']).middleware('auth')
router.get ('/auth/verify/:token', [EmailVerificationController, 'verify'])
```

### 5. Gate verified-only routes

```ts
router.get('/billing',  [BillingController, 'show']).middleware(['auth', 'verified'])
router.get('/api/data', [DataController, 'index']).middleware(['auth', 'verified'])
```

`'verified'` must come after `'auth'` — it reads `ctx.auth.user`, it doesn't populate it. On miss it throws `EmailNotVerifiedError` (`auth.email-not-verified`, status 403).

## Token format

```
<userId>.<unix-seconds>.<hex-hmac-sha256>
```

- `userId` and `unix-seconds` are in cleartext on the URL — that's fine; the HMAC ties them together.
- The HMAC is computed over `${userId}.${unix-seconds}` with `config.app.key` as the secret.
- `verify` does **constant-time** comparison of the signature.

The URL-encodes the whole `<userId>.<ts>.<sig>` payload in the `:token` path segment.

## Tradeoffs

- ✅ No DB write on issuance; no per-request DB read on verify.
- ✅ Cheap to issue in bulk (e.g. on registration).
- ❌ No per-token revocation. The only invalidation knob is `app.key` rotation, which kills *every* outstanding verification + email-changing link in the system.
- ❌ Replayable until expiry — a leaked token is valid until `ttl` elapses.

If you need revocable verification, use `MagicLinkManager` instead (DB-backed, atomic `used_at`).

## Error semantics

`verify(token)` throws `EmailVerificationError` (status 400) with `context.code`:

| Code | Meaning |
|---|---|
| `'invalid'` | Wrong shape, bad signature, non-integer timestamp |
| `'expired'` | `timestamp + ttl < now` |

## Production checklist

- [ ] `config.app.key` is set, ≥32 bytes, not committed to source.
- [ ] `users.email_verified_at` column exists and is indexed if you `WHERE` on it.
- [ ] Rate-limit `POST /auth/verify/resend` per-user (token-bucket / fixed-window).
- [ ] Verification email is queued (`@strav/queue`) so SMTP hiccups don't drop registrations.
- [ ] When a user *changes* their email, set `email_verified_at = NULL` and trigger a new verification email.
