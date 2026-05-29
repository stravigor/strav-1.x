# ADR: Magic links are DB-backed; email verification is stateless HMAC

**Status:** Accepted (auth-extras slice)
**Affects:** `@strav/auth` (`MagicLinkManager`, `EmailVerification`)

## Context

Both magic-link sign-in and email-verification follow the same outward shape: generate a single-purpose URL, email it to the user, accept it back on a later request. It is tempting to ship one primitive and use it for both.

The two flows have different security and operational requirements:

| | Magic link sign-in | Email verification |
|---|---|---|
| **What it proves** | The caller controls the email *and* we should sign them in | The caller controls the email |
| **Side effect on accept** | Mints a session | Updates a column |
| **Replay safety** | MUST be single-use — replay = session hijack on a shared mailbox | Tolerable; replay is idempotent (column already `now()`) |
| **Per-token revocation** | Required (admin-initiated invalidation, account compromise) | Rarely needed; "rotate all" is acceptable |
| **Issuance volume** | Low (one per sign-in attempt) | Can be bulk (registration drip, resend storms) |
| **Failure of issuance** | User retries — UX OK | User sees "verify your email" banner for hours — UX OK |

A single primitive forces one of two compromises:

- **Pure stateless** (HMAC token, no row): no per-token revoke, no atomic single-use guarantee. Acceptable for verification; **not** acceptable for sign-in.
- **Pure DB-backed** (row + `used_at`): one INSERT + one UPDATE per verification email. Wasteful at registration volume and offers nothing the stateless approach lacks for this use case.

## Decision

Ship two distinct primitives with different storage models:

1. **`MagicLinkManager`** — DB-backed. Inserts a row in `strav_magic_links` with `token`, `expires_at`, `used_at`. `consume(token)` is an atomic SELECT-then-UPDATE-`used_at` that rejects replays with `MagicLinkError({ code: 'used' })`. Tokens are 32 random bytes (256-bit) stored as hex plaintext — the security boundary is single-use + short TTL + email delivery, not token secrecy. Revocation is `DELETE` on the row.

2. **`EmailVerification`** — stateless. Token format `<userId>.<timestamp>.<hmac-sha256>` signed with `config.app.key`. No table, no DB write at issuance, no DB read at verify. TTL is bounded by the timestamp; revocation is `app.key` rotation (which invalidates **every** outstanding token).

Both are registered as container singletons by `AuthProvider` and read configuration from `config.auth.magic` / `config.auth.verification` respectively, with `config.app.url` / `config.app.key` as cross-cutting fallbacks.

## Consequences

### Good

- Each primitive is tuned to its use case. Verification gets cheap bulk issuance; sign-in gets atomic single-use.
- The DB-backed path doesn't pay HMAC cost; the stateless path doesn't pay round-trips.
- Apps that need revocable verification (rare) can swap in `MagicLinkManager` for that flow — same shape, different storage.
- The two error types (`MagicLinkError`, `EmailVerificationError`) carry discriminator codes (`'invalid' | 'used' | 'expired'` / `'invalid' | 'expired'`) so renderers can produce useful messaging without string-matching.

### Bad

- Two primitives instead of one — more API surface and more documentation. The guides at `docs/auth/guides/magic-links.md` and `docs/auth/guides/verification.md` exist partly to make the choice obvious.
- `EmailVerification` requires `config.app.key`. `AuthProvider` throws `ConfigError` at boot if it's missing — surfaces the dependency loudly but adds a wiring requirement for apps that previously didn't need an app key.
- Rotating `app.key` invalidates every verification *and* every other HMAC-secured token signed with it. Apps with multi-tenant key isolation needs will outgrow this; that's intentionally deferred.

### Neutral

- The `strav_magic_links` table needs a migration + a prune job (`magic:prune`). The `magic-links.md` guide spells this out. No equivalent ops burden on the verification side.
- Both surfaces accept an injected `now` for deterministic testing — same idiom as the rest of the framework.

## Alternatives considered

- **One unified `LinkManager` with a `single_use` toggle.** Rejected: collapses the decision into a config flag and forces every app to reason about it correctly. Two primitives make the right thing the default for each use case.
- **JWT for both.** Rejected: brings in the JWT design space (algorithms, kid rotation, claims schema) for a problem that doesn't benefit from JWT's interop story. JWT lands as a `Guard` driver post-1.0; tokens for one-shot links don't need it.
- **DB-backed verification with `used_at`.** Rejected: at registration volume the INSERT is dead weight, and `email_verified_at` on the user row is the canonical "has verified" signal anyway. Re-clicking the verification link is harmless.
