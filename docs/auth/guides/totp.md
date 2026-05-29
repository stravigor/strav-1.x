# TOTP (Time-based One-Time Passwords)

RFC 6238 helpers for second-factor auth. Pure `node:crypto`, no external dep, three top-level functions that cover the full enroll-and-verify lifecycle. Apps own the storage column, the lockout policy, and the recovery codes.

## What's in the package

```ts
import { generateSecret, qrUri, verifyTotp } from '@strav/auth'

generateSecret(): string                                       // base32, 160-bit
qrUri(secret, account, issuer): string                         // otpauth://totp/…
verifyTotp(secret, code, options?): boolean
```

Plus base32 primitives (`base32Encode` / `base32Decode`) for tests or custom flows.

## Enroll flow

1. User clicks "Enable 2FA".
2. Backend generates a secret, stores it on the user row (ideally encrypted).
3. Render the `qrUri` as a QR code. User scans with Google Authenticator / Authy / 1Password / etc.
4. User types the 6-digit code from their app. Backend verifies before persisting "2FA enabled".

```ts
// app/http/controllers/two_factor_controller.ts
import type { HttpContext } from '@strav/http'
import { generateSecret, qrUri, verifyTotp, assertAuth } from '@strav/auth'

export class TwoFactorController {
  // POST /settings/2fa/start — return a fresh secret + QR URI
  async start(ctx: HttpContext) {
    const user = await assertAuth(ctx).userOrFail()
    const secret = generateSecret()
    // Store provisionally; only mark "enabled" once user confirms with a code.
    await userRepository.setPendingTotpSecret(user.id, secret)
    return ctx.response.ok({
      secret,
      qr: qrUri(secret, user.email, 'MyApp'),
    })
  }

  // POST /settings/2fa/confirm — { code }
  async confirm(ctx: HttpContext) {
    const user = await assertAuth(ctx).userOrFail()
    const { code } = await ctx.request.body<{ code: string }>()
    const ok = verifyTotp(user.totp_secret_pending, code)
    if (!ok) return ctx.response.badRequest({ error: 'Invalid code.' })
    await userRepository.confirmTotp(user.id)  // promote pending → active, set totp_enabled_at
    return ctx.response.ok({ enabled: true })
  }
}
```

## Verify flow (login)

After the user passes the password / magic-link step, gate the session on a TOTP code:

```ts
async login(ctx: HttpContext) {
  const { email, password, code } = await ctx.request.body<…>()
  const user = await userRepository.byEmail(email)
  if (!user || !(await hasher.verify(password, user.password_hash))) {
    return ctx.response.unauthorized()
  }
  if (user.totp_enabled_at && !verifyTotp(user.totp_secret, code ?? '')) {
    return ctx.response.unauthorized({ error: '2FA code required.' })
  }
  await ctx.auth!.login(user)
  return ctx.response.ok()
}
```

## Secret storage

`totp_secret` is base32 plaintext (~32 chars). Apps should encrypt at rest. The cleanest path is `@encrypt` on the schema field:

```ts
defineSchema('users', Archetype.Account, (t) => {
  t.id()
  t.string('email').unique()
  t.string('totp_secret').nullable().decorators('@encrypt')
  t.timestamp('totp_enabled_at').nullable()
  // …
})
```

The repository layer decrypts before the value reaches your controller, so `verifyTotp(user.totp_secret, code)` works without ceremony.

## Clock skew

`verifyTotp` checks the current 30-second window ±1 step by default (i.e. ±30s). Most authenticator apps drift well within that. To widen for older devices:

```ts
verifyTotp(secret, code, { window: 2 })   // ±60s
```

Wider windows trade off security — the attacker has more valid codes per any given moment.

## Options

```ts
interface TotpOptions {
  digits?: number   // default 6
  window?: number   // ± steps. Default 1
  period?: number   // step seconds. Default 30
}
```

Defaults match what every authenticator app expects. Only deviate if you're integrating with a system that requires it.

## Recovery codes

`@strav/auth` does **not** generate recovery codes — apps own that. The typical shape:

1. On TOTP enroll, generate 10 random codes (e.g. `randomBytes(5).toString('hex')`).
2. Hash each (SHA-256) and store the hashes in a `totp_recovery_codes` table.
3. Show the plaintext codes to the user *once*.
4. On login, if the user enters a recovery code instead of a TOTP code, look up by hash, delete the row, accept.

The `AccessTokenRepository` pattern (`createToken` / `findByPlaintext`) is the model — same primitive, different table.

## Brute-force protection

`verifyTotp` does not rate-limit. Apps must:

- Throttle the verify endpoint per-user (e.g. 5 attempts / 5 minutes).
- Lock the account on N consecutive failures and require email-based recovery.
- Optionally log to your audit trail.

A 6-digit code has 1,000,000 possible values; with the default ±1 window there are 3 valid codes per any moment → roughly 1-in-333,000 per guess. Strong enough *if* you rate-limit; trivial to brute-force without.

## API reference

See [`api.md`](../api.md#totp) for signatures.
