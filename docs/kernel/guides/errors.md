# Errors — the StravError hierarchy

Every error the framework raises descends from a single abstract base, `StravError`. The hierarchy is intentionally flat — eight concrete subclasses cover the common cases an HTTP/queue/console kernel needs to discriminate, and every error carries the same four fields.

## The contract

| Field | Type | Notes |
|---|---|---|
| `code` | `string` | Machine-readable; subclass default unless overridden via options |
| `status` | `number` | HTTP-shaped status; subclass-fixed |
| `context` | `Readonly<Record<string, unknown>>` | Structured payload (frozen at construction) |
| `cause` | `unknown` | Standard ES2022 `Error.cause` |
| `message` | `string` | Human-readable; subclasses ship a sensible default |
| `name` | `string` | Always the concrete subclass name |

Plus `toJSON()` for safe serialization. `JSON.stringify(error)` returns a clean payload — never the stack trace, never `cause`, never anything internal.

## The subclasses

| Class | Status | Default code | Use it when… |
|---|---|---|---|
| `ValidationError` | 422 | `validation-error` | Input validation failed; carries an `errors` map keyed by field path |
| `AuthError` | 401 | `auth-error` | Request is unauthenticated (no/invalid/expired credentials) |
| `AuthorizationError` | 403 | `authorization-error` | Authenticated, but not allowed to do *this* |
| `NotFoundError` | 404 | `not-found` | Resource doesn't exist (`findOrFail`, route resource missing) |
| `ConflictError` | 409 | `conflict` | State conflict (unique constraint about to fail, "already exists") |
| `RateLimitError` | 429 | `rate-limited` | Throttled; carries `retryAfter` (seconds) for the `Retry-After` header |
| `ConfigError` | 500 | `config-error` | Boot-time configuration is invalid or missing |
| `ServerError` | 500 | `server-error` | Generic fallback; `asStravError` wraps unknowns in this |

## Throwing

```ts
import { ValidationError, NotFoundError, ConflictError } from '@strav/kernel'

// Plain — message + default code/status
throw new NotFoundError('user not found')

// With context — structured, log-safe
throw new NotFoundError('user not found', { context: { id: userId } })

// With a domain code — overrides the subclass default
throw new ConflictError('email is blacklisted', { code: 'user.email-blacklisted' })

// With a cause chain — preserves the underlying throwable
try {
  await pool.query(/* ... */)
} catch (cause) {
  throw new ServerError('failed to load users', { cause })
}

// Validation — field errors are first-class
throw new ValidationError('Validation failed.', {
  errors: {
    email: ['required', 'must be a valid email'],
    password: ['too short'],
  },
})
```

## Catching

```ts
import { isStravError, NotFoundError } from '@strav/kernel'

try {
  await userRepo.findOrFail(id)
} catch (err) {
  if (err instanceof NotFoundError) {
    return notFoundView()
  }
  if (isStravError(err)) {
    logger.warn({ code: err.code, status: err.status }, err.message)
    throw err
  }
  // Truly unexpected — let the kernel's exception handler take it.
  throw err
}
```

`isStravError(err)` is the type-guard you want when you don't care which subclass: it narrows `err` to `StravError` so `err.code`, `err.status`, `err.context`, and `err.toJSON()` all type-check.

## `asStravError` — normalize unknowns

When an HTTP/queue/console kernel catches an error it didn't anticipate, it normalises it before reporting:

```ts
import { asStravError } from '@strav/kernel'

try {
  await handler(ctx)
} catch (caught) {
  const error = asStravError(caught)
  //    ^^^^^ always a StravError now — guaranteed code/status/context/toJSON
  return errorResponse(error)
}
```

- If `caught` is already a `StravError`, it's returned unchanged.
- If it's any other `Error`, it's wrapped in `ServerError` with the original preserved as `cause` and the original `message` carried through.
- If it's something weird (`throw 'boom'`, `throw null`), it's wrapped in `ServerError` with the fallback message.

The stack chain stays intact because we use the ES2022 `Error.cause` slot.

## `toJSON` — what a serialized error looks like

```ts
const err = new ValidationError('Validation failed.', {
  errors: { email: ['required'] },
  context: { source: 'sign-up form' },
})

JSON.stringify(err)
// {
//   "name": "ValidationError",
//   "code": "validation-error",
//   "status": 422,
//   "message": "Validation failed.",
//   "context": { "source": "sign-up form" },
//   "errors": { "email": ["required"] }
// }
```

- Empty `context` is **omitted** from the JSON.
- `cause` is **not** serialized — you don't want internal error chains escaping to API consumers.
- `stack` is **not** serialized either — log it explicitly if you want it.
- Subclasses that add their own first-class fields (`ValidationError.errors`, `RateLimitError.retryAfter`) override `toJSON` to surface them.

## RateLimitError — the `Retry-After` story

```ts
throw new RateLimitError('rate limited; try later', { retryAfter: 30 })
//                                                    ^^^^^^^^^^^^^^ seconds
```

The HTTP kernel's exception handler will set `Retry-After: 30` when it sees a `RateLimitError` with `retryAfter` defined. If you don't know how long the cool-down is, omit `retryAfter` and the header isn't set.

## ValidationError — the `errors` map

`errors` is `Record<string, readonly string[]>` keyed by dotted field path:

```ts
throw new ValidationError('Validation failed.', {
  errors: {
    'email':            ['required', 'must be a valid email'],
    'profile.address':  ['required'],
    'items.0.quantity': ['must be ≥ 1'],
  },
})
```

The map and each array are frozen — pass-through with no defensive copy needed at the boundary.

## Custom error codes

Sometimes you want a domain-specific code without inventing a new class:

```ts
throw new ConflictError('email is already taken', { code: 'user.email-taken' })
throw new ConflictError('email is blacklisted',   { code: 'user.email-blacklisted' })
```

`status` stays `409` (subclass-fixed), but the `code` distinguishes the two cases in logs and clients.

The convention is `domain.specific-thing` — lowercase, dotted segments, kebab inside a segment. Reserve the bare subclass-default codes (`conflict`, `not-found`) for when the situation really is just "generic conflict".

## Subclassing in your app

If a code path keeps reaching for "same status, same domain code", encapsulate it:

```ts
import { ConflictError, type StravErrorOptions } from '@strav/kernel'

export class EmailBlacklistedError extends ConflictError {
  constructor(email: string, options: StravErrorOptions = {}) {
    super(`Email "${email}" is blacklisted.`, {
      ...options,
      code: 'user.email-blacklisted',
      context: { email, ...options.context },
    })
  }
}
```

`instanceof EmailBlacklistedError` still narrows to a `ConflictError` and a `StravError` — so the kernel's exception handler treats it as a 409, and your specific catch branches still work.

## When NOT to use StravError

| Situation | Use this instead |
|---|---|
| Programmer-error checks (e.g., bad arg types in your own code) | Throw a plain `Error` — it should never reach a kernel handler in practice |
| Things you want to recover from with a value, not a throw | Return a result, don't throw at all |
| Adapting a third-party error you intend to swallow | Catch, log, move on — don't rewrap unless the error escapes |

`StravError` is for **errors that cross a layer boundary**: a controller throws, the kernel renders. If it doesn't cross, a plain `Error` is fine.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `err.code is undefined` in a catch block | The thrown value isn't a `StravError` | Guard with `isStravError(err)` before touching the field |
| `JSON.stringify(err)` returns `{}` | The error isn't a `StravError` — plain Errors don't serialize their fields | Wrap via `asStravError(err)` before serializing |
| Stack trace points to `strav_error.ts` | Old V8 build without `Error.captureStackTrace` | Bun is V8-based — should not occur in supported runtimes |
| `error.context.foo = 'x'` throws | `context` is frozen at construction | Build the context object before throwing; don't mutate after |
