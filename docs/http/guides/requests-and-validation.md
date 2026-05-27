# Requests and validation — `FormRequest`, `rule`, custom rules

`FormRequest` is the typed-payload primitive: it gates authorization, transforms input, validates against a Zod schema, and exposes a typed `validated()` accessor. Two dispatch shapes ship today — see [ADR: FormRequest dispatch](../../decisions/form-request-dispatch.md) for why the spec's auto-detected `(req, ctx)` form is deferred.

## Anatomy

```ts
// app/http/requests/store_user_request.ts
import { FormRequest, rule } from '@strav/http'
import type { HttpContext } from '@strav/http'

export class StoreUserRequest extends FormRequest<{
  email: string
  name: string
  password: string
}> {
  override authorize(ctx: HttpContext): boolean {
    // ctx.auth lands with @strav/auth — for now you can read what you need
    // off ctx.state / ctx.container / ctx.request.
    return true
  }

  override transform(input: Record<string, unknown>) {
    return { ...input, email: String(input.email ?? '').toLowerCase().trim() }
  }

  rules() {
    return {
      email:    rule.email(),
      name:     rule.string().min(1).max(255),
      password: rule.string().min(12),
    }
  }
}
```

The lifecycle, run by `from(ctx)`:

1. **Construct** — `new SomeRequest(ctx)`. Body isn't parsed yet.
2. **Authorize** — `authorize(ctx)`. `false` throws `AuthorizationError` (`policy.denied`, 403). A thrown `StravError` propagates with its own code.
3. **Transform** — pre-validation mutation. Receives the parsed body (or `{}` for empty bodies); returns the object to validate.
4. **Validate** — Zod safe-parse. Failure throws `ValidationError` (`validation.failed`, 422) with the spec's `errors[field]: [{code, message, context?}]` shape.
5. **Cache** — populated payload stored for `validated()`.

If any phase throws, the controller action never runs — the kernel's `ExceptionHandler` formats the response.

## Two dispatch shapes

### A. Explicit (always works)

```ts
async store(ctx: HttpContext): Promise<Response> {
  const req = await StoreUserRequest.from(ctx)
  const data = req.validated()                    // typed
  const user = await this.users.create(data)
  return ctx.response.created(user)
}
```

Use this when:

- You want zero magic.
- The FormRequest is conditional (you sometimes validate, sometimes don't).
- The action needs to construct multiple FormRequests for nested payloads.

### B. Tuple-arity-3 router sugar

```ts
router.post('/users', [UserController, 'store', StoreUserRequest])
```

In the controller:

```ts
@inject()
export class UserController {
  constructor(private users: UserRepository) {}

  async store(req: StoreUserRequest, ctx: HttpContext): Promise<Response> {
    const user = await this.users.create(req.validated())
    return ctx.response.created(user)
  }
}
```

The router accepts an optional third tuple element; the kernel detects it, runs `FormRequest.from(ctx)` for you, and calls `controller.store(req, ctx)`. Failures (authorize/validate) short-circuit before the action runs.

Use this when:

- The route is always paired with a single FormRequest (the common case).
- You want the dispatch shape visible at the route, not buried in the action.

## The `rule.*` API

`rule` is a thin façade over Zod v4. Every builder returns a Zod schema (preserving its chainable methods), so `.min/.max/.email/.refine/etc` continue to work and raw `z.*` schemas drop in on any field.

### Builders

| Builder | Returns | Common chain |
|---|---|---|
| `rule.string()` | `ZodString` | `.min(n).max(n).regex(...)` |
| `rule.number()` | `ZodNumber` | `.int().min(0).max(100).positive()` |
| `rule.boolean()` | `ZodBoolean` | — |
| `rule.date()` | `ZodDate` | `.min(date).max(date)` |
| `rule.email()` | `ZodString` (email format) | `.min(n)` |
| `rule.url()` / `.uuid()` / `.ulid()` | `ZodString` (format-checked) | — |
| `rule.enum(['a','b','c'])` | `ZodEnum` | — |
| `rule.array(item)` | `ZodArray` | `.min(n).max(n)` |
| `rule.object({...})` | `ZodObject` | `.passthrough() / .strict()` |
| `rule.union([a, b])` | `ZodUnion` | — |
| `rule.optional(schema)` | `T | undefined` | — |
| `rule.nullable(schema)` | `T | null` | — |

### Modifiers (from Zod, work on every builder)

- `.optional()` — may be `undefined`.
- `.nullable()` — may be `null`.
- `.default(value)` — fill in if missing.
- `.refine(fn, error)` — inline custom check; the second arg can be a string code or `{ message, params: { code, context? } }`.
- `.pipe(another)` — apply a follow-up schema. Use to layer `rule.custom(...)` on top of a typed base.

### Mixing raw Zod

```ts
import { z } from '@strav/http'                 // same `z` you'd import from 'zod'

rules() {
  return {
    age: z.number().int().min(13).max(120),     // raw Zod
    role: rule.enum(['admin', 'staff']),         // rule.* helper
    tags: rule.array(rule.string().max(50)).max(10),
  }
}
```

For request-wide / cross-field rules, return a single Zod schema instead of a field-map:

```ts
rules() {
  return z.object({
    kind:  z.enum(['a', 'b']),
    value: z.number(),
  }).superRefine((p, c) => {
    if (p.kind === 'a' && p.value < 0) {
      c.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'rule.value.negative_for_kind_a',
        params: { code: 'rule.value.negative_for_kind_a' },
      })
    }
  })
}
```

### Inline refines

```ts
password: rule
  .string()
  .min(12)
  .refine((s) => /[A-Z]/.test(s), {
    message: 'rule.password.no_upper',
    params: { code: 'rule.password.no_upper' },
  })
```

The `params.code` is what the framework surfaces in the validation error response. The `message` is the human-readable fallback (translated by i18n once that lands).

## Registered custom rules

For a check used in many places, register once and reference by name:

```ts
// app/validation/rules.ts
import { registerRule, type RuleContext } from '@strav/http'

registerRule(
  'unique',
  async (value, ctx: RuleContext, args: { table: string; column: string; except?: string }) => {
    const repo = ctx.container.make(resolveRepo(args.table))
    const found = await repo.findOneBy({ [args.column]: value })
    if (!found) return true
    if (found.id === args.except) return true
    return { code: 'rule.unique', context: { column: args.column } }
  },
)

registerRule('strong_password', (value: string) => {
  if (value.length < 12) return { code: 'rule.password.too_short', context: { min: 12 } }
  if (!/[A-Z]/.test(value)) return 'rule.password.no_upper'
  if (!/[0-9]/.test(value)) return 'rule.password.no_digit'
  if (!/[^A-Za-z0-9]/.test(value)) return 'rule.password.no_symbol'
  return true
})
```

Import the file once at boot so the side-effect calls run (`AppProvider.register()` is the typical spot).

Then apply via `.pipe(rule.custom(...))`:

```ts
rules() {
  return {
    password: rule.string().pipe(rule.custom('strong_password')),
    handle:   rule.string().min(3).pipe(rule.custom('unique', {
      table: 'users',
      column: 'handle',
      except: this.ctx.request.params.id,    // editing — exclude current row
    })),
  }
}
```

`this.ctx` is the request's `HttpContext`, available inside `rules()` — so rule args can depend on the route params, the current user, etc.

### Rule return values

| Return | Means |
|---|---|
| `true` | pass |
| `false` | fail with `rule.<name>` as the code |
| `string` | fail with that **code** (no context) |
| `{ code, context? }` | fail with code + context for `{placeholder}` interpolation at translate time |

Rules never emit user-facing messages — codes are translated by i18n at response time (currently passed through unchanged until `@strav/kernel/i18n` lands).

## Error shape on the wire

```json
{
  "error": {
    "code": "validation.failed",
    "message": "StoreUserRequest: validation failed.",
    "errors": {
      "email": [
        { "code": "rule.invalid_format", "message": "Invalid email address" }
      ],
      "name": [
        { "code": "rule.too_small", "message": "String must contain at least 1 character(s)" }
      ],
      "user.email": [
        { "code": "rule.invalid_format", "message": "Invalid email address" }
      ]
    }
  }
}
```

- Field keys use Zod's path with `.` joins (`user.email` for nested).
- `code` is stable — `rule.<reason>` for built-in failures; `rule.<name>[.suffix]` for registered/inline rules; whatever the caller passed for `params.code`.
- `message` is the human fallback; will be replaced by i18n's translation when that subsystem ships.

## Testing

```ts
const app = await bootApp()
const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ email: 'bad', name: '' }),
}))
expect(res.status).toBe(422)
const body = await res.json()
expect(body.error.errors.email).toBeDefined()
```

For rule-level unit tests, drive the registered function directly with a stub `HttpContext` — no kernel needed.

## What's not here yet

- **Type-detected `(req: SomeRequest, ctx)` action signature.** Per the [ADR](../../decisions/form-request-dispatch.md), deferred until there's a clean per-method decorator pattern.
- **i18n translation of codes.** The shape on the wire is stable; the framework passes codes through unchanged until `@strav/kernel/i18n` is ready.
- **Multipart file binding.** Use `ctx.request.file(name)` from inside the action for now.
- **Cross-field policy gates.** Use `.superRefine` on a single-schema `rules()` until `@strav/auth`'s policy primitive lands.
