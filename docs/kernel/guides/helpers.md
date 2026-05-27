# Helpers — Clock, crypto, ULID

Small utilities that show up everywhere — IDs, tokens, fingerprints, time. They're plain functions and classes; no DI required (though `Clock` is built to be injected).

## `Clock` — abstracting "now"

Code that reads `Date.now()` directly is hard to test. Inject a `Clock` instead.

```ts
import { type Clock, SystemClock, inject } from '@strav/kernel'

@inject()
class TokenIssuer {
  constructor(private clock: Clock) {}

  issue(): { token: string; expiresAt: number } {
    return { token: '…', expiresAt: this.clock.millis() + 3600_000 }
  }
}

// Production: bind SystemClock
app.singleton<Clock>('Clock', () => new SystemClock())
```

In a test:

```ts
import { FrozenClock } from '@strav/kernel'

const clock = new FrozenClock('2026-06-01T12:00:00Z')
const issuer = new TokenIssuer(clock)

const a = issuer.issue()
clock.advance(60_000)
const b = issuer.issue()

expect(b.expiresAt - a.expiresAt).toBe(60_000)
```

### When NOT to use `Clock`

- Performance-sensitive hot paths where `Date.now()` overhead matters (rare).
- Code that genuinely should fail when the wall clock skews — e.g., TLS cert validation.

Otherwise inject it.

## ULID

Time-ordered, sortable string IDs. Use these for primary keys in time-ordered tables (users, orders, audit logs, jobs) — they sort by creation time without needing a separate `created_at` index.

```ts
import { ulid, isUlid, decodeUlidTime } from '@strav/kernel'

const id = ulid()                  // '01JC...XYZ' — 26 chars
isUlid(id)                         // true
decodeUlidTime(id)                 // ≈ Date.now()
```

### Monotonic within a millisecond

Two calls in the same millisecond produce strictly-increasing outputs:

```ts
const t = 1_700_000_000_000
const a = ulid(t)
const b = ulid(t)
a < b // true — sortable even within the same ms
```

This is critical for paginated queries that sort by ID: without monotonicity, two ULIDs generated in the same millisecond could appear in arbitrary order.

### Injecting timestamp from a `Clock`

```ts
const id = ulid(clock.millis())
```

### Sortable as a database column

In Postgres, store ULIDs as `text` or `char(26)`. ORDER BY id is equivalent to ORDER BY creation time — no extra index needed.

```sql
CREATE TABLE users (
  id char(26) PRIMARY KEY,
  -- ...
);

-- These produce the same ordering:
SELECT * FROM users ORDER BY id DESC;
SELECT * FROM users ORDER BY created_at DESC;
```

### When NOT to use ULID

- Externally-visible IDs where you want to obscure creation time (use `randomUUID()` or `randomToken()`).
- High-throughput contexts where 2⁸⁰ random per ms ever becomes a real concern (it won't — that's ~10²⁴ IDs per ms).

## Crypto helpers

Thin wrappers over `node:crypto`. **Password hashing belongs in `@strav/auth` (bcrypt/argon2); these primitives are for tokens, fingerprints, and signed values.**

### Random tokens

```ts
import { randomToken, randomBytes, randomUUID } from '@strav/kernel'

randomToken()      // 43-char base64url — default 32 bytes of entropy
randomToken(16)    // shorter — 22 chars
randomBytes(32)    // raw Buffer when you need to encode differently
randomUUID()       // 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
```

Use `randomToken` for session IDs, CSRF tokens, magic-link tokens, API keys. The default 256-bit entropy is more than enough.

### Hashing

```ts
import { sha256, hmacSha256 } from '@strav/kernel'

// Fingerprint — deterministic, public-safe
const fingerprint = sha256(`${user.email}|${user.id}`)

// Signed value — server-controlled key, can be re-verified
const secret = env.required('APP_KEY')
const signature = hmacSha256(secret, `${userId}.${sessionId}`)
```

Both return hex strings. Use `hmacSha256` when you need a key (signed cookies, JWT-like compact tokens, derived subkeys). Use `sha256` when you want a deterministic fingerprint anyone can recompute.

### Constant-time comparison

```ts
import { constantTimeEqual } from '@strav/kernel'

// Comparing a presented token against a stored one
if (!constantTimeEqual(presented, stored)) {
  throw new AuthError('invalid token')
}
```

**Always use `constantTimeEqual` for secret comparisons.** `===` returns `false` as soon as the first differing byte is found, leaking timing information that lets attackers brute-force token bytes one at a time. `constantTimeEqual` always reads the full length.

Two implementation notes:

1. **Length mismatch returns `false` without comparing.** Node's `timingSafeEqual` errors on length mismatch; we short-circuit because length leakage is universal and unavoidable.
2. **String length is byte length, not char length.** `constantTimeEqual('é', 'e')` returns `false` — `é` is 2 UTF-8 bytes, `e` is 1.

## Common patterns

### Issuing an opaque session token

```ts
import { randomToken, sha256 } from '@strav/kernel'

const token = randomToken()                 // give this to the client
const tokenHash = sha256(token)             // store this in DB

// On lookup, hash the presented token and compare in DB
const presentedHash = sha256(presentedToken)
const session = await sessions.findByHash(presentedHash)
```

We never store the raw token — only its hash. A DB leak doesn't compromise live sessions.

### Signing a cookie value

```ts
import { hmacSha256, constantTimeEqual } from '@strav/kernel'

const secret = config.get('app.key') as string

function sign(value: string): string {
  return `${value}.${hmacSha256(secret, value)}`
}

function verify(signed: string): string | null {
  const [value, sig] = signed.split('.')
  if (!value || !sig) return null
  if (!constantTimeEqual(sig, hmacSha256(secret, value))) return null
  return value
}
```

### Time-ordered audit log row

```ts
import { ulid } from '@strav/kernel'

await auditLog.insert({
  id: ulid(clock.millis()),
  actor_id: user.id,
  action: 'role.granted',
  context: { target: role },
})
```

The ID *is* the timestamp. Querying recent rows: `ORDER BY id DESC LIMIT 100`.

## Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Test flakes — timestamps differ across runs | Production code reads `Date.now()` directly | Inject `Clock`; bind `FrozenClock` in tests |
| `===` works in tests but timing attack succeeds in prod | Token comparison uses `===` | Use `constantTimeEqual` for any secret |
| Two ULIDs in the same ms sort wrong | Mixing this `ulid()` with another generator | Stick to one generator per process |
| `randomToken()` chars don't fit a URL/header constraint | URL-safe alphabet still includes `_` and `-` | Use a custom encoder if you need stricter character sets |
| ULID is shorter than expected | Likely a `Buffer.toString()` somewhere stripping chars | ULID is exactly 26 chars — `isUlid()` is the runtime check |
