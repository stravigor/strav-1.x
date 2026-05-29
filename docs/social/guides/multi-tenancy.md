# Multi-tenancy

**Framework rule**: multitenancy is opt-in, never default. `@strav/social`'s default `social_account` schema has no `tenant_id` column; apps that need per-tenant social-account isolation explicitly opt into the tenanted variant via `@strav/social/tenanted`.

If you're building a single-tenant app, a B2C app with no workspace concept, or a SaaS where social accounts are inherently global (e.g. each user has one Google account regardless of which workspace they're in), stay on the default. Multi-tenant SaaS apps with per-workspace identity isolation use the tenanted variant.

## When you need the tenanted variant

The same Google account legitimately belongs to two different "users" in your app, each scoped to a different tenant:

- User Alice has access to two SaaS workspaces (Acme + Globex). Each workspace has its own "user" record for her; both link the same Google account.
- A B2B platform where the same individual joins multiple tenant orgs.

In single-tenant apps or "one user per identity globally" apps, this never happens. Stay on the default.

## Opt-in

```ts
// migration
import { applyTenantedSocialAccountMigration } from '@strav/social/tenanted'

export const migration: Migration = {
  name: '20260601000000_create_social_account_tenanted',
  async up(db) {
    await applyTenantedSocialAccountMigration(db, { registry })
  },
}
```

```ts
// bootstrap/providers.ts — wire the repository explicitly
import { TenantedSocialAccountRepository } from '@strav/social/tenanted'
import { Cipher } from '@strav/kernel'
import { PostgresDatabase, SchemaRegistry } from '@strav/database'

class TenantedSocialAppProvider extends ServiceProvider {
  override readonly name = 'social-app'
  override readonly dependencies = ['social', 'database']

  override register(app: Application): void {
    app.singleton(
      TenantedSocialAccountRepository,
      (c) =>
        new TenantedSocialAccountRepository(
          c.resolve(PostgresDatabase),
          c.resolve(EventBus),
          c.resolve(SchemaRegistry),
          c.resolve(Cipher),
        ),
    )
  }
}
```

## Sign-in flow inside `withTenant`

```ts
const tenants = container.resolve(TenantManager)
const accounts = container.resolve(TenantedSocialAccountRepository)

const tokens = await social.use('line').exchange({ … })
const profile = await social.use('line').profile(tokens.accessToken)

// Tenant context is set by your subdomain / header middleware.
const tenantId = currentRequest.tenant.id

await tenants.withTenant(tenantId, async () => {
  const existing = await accounts.findByProviderIdentity('line', profile.id)
  if (existing) {
    return loginUser(existing.user_id)
  }
  await accounts.connect({ userId: newUser.id, provider: 'line', profile, tokens })
})
```

The Repository's queries are identical to the default's; the only operational difference is the `withTenant` wrapper.

## What RLS gives you

The tenanted schema declares `tenanted: true`, which makes `@strav/database` inject a `tenant_id` column + an RLS policy scoping every `SELECT / INSERT / UPDATE / DELETE` by `current_setting('app.tenant_id')`. So:

- Tenant A's `findByProviderIdentity('line', 'U_shared')` returns Tenant A's row.
- Tenant B's same query returns Tenant B's row.
- Neither tenant can see or accidentally update the other's row, even with the same `provider_user_id`.

The composite unique is `(tenant_id, provider, provider_user_id)` — same identity can exist once per tenant.

## Don't run both migrations

The default and tenanted variants both create a table named `social_account`. Pick one before your first deploy; switching between them is a one-way migration (you'd need to add or drop the `tenant_id` column, backfill, and update indexes — not done automatically).

## What you give up

By going tenanted, you commit to:

- Every social-account query happening inside `withTenant(...)`. Forgetting the wrapper means the `INSERT` fails (RLS rejects writes with an unset `app.tenant_id`).
- Sign-in handlers that resolve the tenant **before** the social ledger lookup. Apps with subdomain-based tenancy already do this; apps that route tenant from a request body might need to restructure.
- Slightly more complex testing — every integration test that touches social accounts has to set the session var.

If those costs don't pay off in your app, stick with the default.

## Multi-tenant sign-up flow

When a user signs in to a tenant they don't yet have an account in, the typical flow:

```ts
await tenants.withTenant(tenantId, async () => {
  const existing = await accounts.findByProviderIdentity('line', profile.id)
  if (existing) return loginUser(existing.user_id)

  // No account yet in THIS tenant. Branch on whether the identity exists in another tenant.
  // The simplest read: bypass RLS via a superuser query inside withoutTenant().
  const globalLink = await tenants.withoutTenant(async () => {
    return globalIdentityRepo.findByProviderIdentity('line', profile.id)
  })

  if (globalLink) {
    // Existing identity in another tenant. Confirm with the user before linking
    // (privacy: this exposes that the user has another tenant).
    return confirmAddToTenant({ existingUserId: globalLink.user_id })
  }

  // True new signup.
  const user = await users.create({ tenant_id: tenantId, email: profile.email })
  await accounts.connect({ userId: user.id, provider: 'line', profile, tokens })
  return loginUser(user.id)
})
```

This is app-specific — there's no single right answer for "user has identity in tenant A, signs in to tenant B". Most apps treat them as fully separate.
