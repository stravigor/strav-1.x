# Policies & Gates

`Gate` is the central registry for "can this user perform this action?" decisions. It backs `ctx.auth.authorize`, `ctx.auth.can`, `ctx.auth.cannot`, and the `policy:resource,ability` middleware.

Two flavors of authorization share the same `Gate` instance:

1. **Policy classes** — resource-scoped. `gate.policy(Lead, LeadPolicy)`. `authorize('update', lead)` calls `LeadPolicy.update(user, lead)`.
2. **Gate ability functions** — standalone. `gate.define('admin.access', user => …)`. `can('admin.access')` calls the function.

## Setup

`AuthProvider` registers `Gate` as a container singleton. Register policies + abilities in a `ServiceProvider.boot()` after the auth provider has booted:

```ts
// app/providers/policy_provider.ts
import { ServiceProvider } from '@strav/kernel'
import { Gate } from '@strav/auth'
import { Lead } from '../models/lead.ts'
import { LeadPolicy } from '../policies/lead_policy.ts'
import { leadRepository } from '../repositories/leads.ts'

export class PolicyProvider extends ServiceProvider {
  override boot(app) {
    const gate = app.resolve(Gate)

    // Resource-scoped policies
    gate.policy(Lead, LeadPolicy)

    // Standalone abilities
    gate.define('admin.access', (user) => user.role === 'admin')
    gate.define('billing.manage', (user, account) => user.id === account.owner_id)

    // Resource loaders for the `policy:…` middleware
    gate.resource('leads', (id) => leadRepository.find(id))
  }
}
```

Register it on the app *after* `AuthProvider`:

```ts
app.useProviders([
  /* …kernel, http, database, auth… */
  new AuthProvider(),
  new PolicyProvider(),
])
```

## Writing a policy

Policies are plain classes — no decorators, no base class. Methods receive the user as the first argument and the resource as the second:

```ts
// app/policies/lead_policy.ts
import type { Authenticatable } from '@strav/auth'
import type { Lead } from '../models/lead.ts'

export class LeadPolicy {
  async view(user: User, lead: Lead) {
    return lead.account_id === user.account_id
  }

  async update(user: User, lead: Lead) {
    return lead.owner_id === user.id || user.role === 'admin'
  }

  async destroy(user: User, lead: Lead) {
    return user.role === 'admin'
  }
}
```

Methods can be sync or async. They return a boolean — or throw `AuthorizationError` with a custom message for richer denial reasons.

## Calling from a controller

```ts
import { assertAuth } from '@strav/auth'

async update(ctx) {
  const lead = await leadRepository.findOrFail(ctx.request.params.id)
  await ctx.auth!.authorize('update', lead)     // throws AuthorizationError on deny
  // …safe to mutate
}

async index(ctx) {
  if (await ctx.auth!.can('admin.access')) {
    // include sensitive columns
  }
}
```

`authorize` throws `AuthorizationError` (status 403). The default exception handler renders 403 JSON / minimal HTML. `can` / `cannot` are non-throwing.

All three call `populate()` internally, so you don't need to `await ctx.auth.check()` first.

## The `policy:resource,ability` middleware

Sugar for the load-then-authorize pattern. Pattern: `policy:<resourceKey>,<ability>`.

```ts
router.put('/leads/:id', [LeadController, 'update'])
  .middleware(['auth', 'policy:leads,update'])
```

What happens:

1. Pull `:id` from `ctx.request.params`.
2. Call the loader registered via `gate.resource('leads', loader)`.
3. If the loader returns `null` → respond `404 Not Found`, skip the controller.
4. Otherwise call `ctx.auth.authorize('update', resource)`. On deny → 403.

The route **must** have a `:id` param and **must** apply `'auth'` before `'policy:…'`. Failing either throws a plain `Error` (developer mistake).

## Gate ability functions

Use when the check isn't tied to a single resource — feature flags, role gates, plan checks:

```ts
gate.define('admin.access',    (user) => user.role === 'admin')
gate.define('feature.beta-ui', (user) => user.beta_opted_in)
gate.define('quota.create-lead', async (user) => {
  const count = await leadRepository.countForUser(user.id)
  return count < user.plan.max_leads
})

// Usage
if (await ctx.auth!.can('quota.create-lead')) { /* … */ }
```

Gate abilities can also take extra args:

```ts
gate.define('billing.manage', (user, account) => user.id === account.owner_id)
await ctx.auth!.can('billing.manage', account)
```

## How resolution works

`gate.authorize(ability, user, ...args)`:

1. **Policy lookup** — when `args[0]` is an object, the gate uses its constructor as the policy key. If a policy is registered for that constructor, it instantiates the policy class and calls `policy[ability](user, ...args)`. Missing method → `AuthorizationError("Policy LeadPolicy does not define ability 'update'.")`.
2. **Ability fallback** — otherwise (or if no policy is registered) it looks up the named ability function and calls it.
3. **Neither found** → `AuthorizationError('No policy or gate found for ability "update". …')`.

That ordering means `gate.define('update', …)` is shadowed by a registered policy whenever a resource object is passed. Use distinct names for global abilities (e.g. `'admin.access'`, not `'view'`) to avoid collisions.

## Errors

```ts
class AuthorizationError extends StravError {
  code = 'auth.unauthorized'
  status = 403
}
```

- `authorize` propagates it.
- `can` swallows it (returns `false`); unrelated errors still propagate.
- `cannot` is `!can`.

The default `HttpExceptionHandler` renders it as 403 JSON `{ "error": "Not authorized." }` (or your handler's HTML for `Accept: text/html`).

## Testing

```ts
import { Gate } from '@strav/auth'

const gate = new Gate()
gate.policy(Lead, LeadPolicy)

await expect(gate.can('update', alice, ownedLead)).resolves.toBe(true)
await expect(gate.can('update', alice, someoneElsesLead)).resolves.toBe(false)
await expect(gate.authorize('update', alice, someoneElsesLead))
  .rejects.toBeInstanceOf(AuthorizationError)
```

The `policy` test suite under `packages/auth/tests/policy.test.ts` is the source of truth for behavior.

## API reference

See [`api.md`](../api.md#gate--policies--abilities) for full signatures.
