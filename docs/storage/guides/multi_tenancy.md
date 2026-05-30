# Multi-tenancy

Multi-tenant apps face a single question: how do you isolate one tenant's files from another's? Three answers exist, in increasing order of operational cost.

| Pattern | Isolation | Operational cost | When |
|---|---|---|---|
| **Prefix-per-tenant** | Logical (your app enforces) | Cheapest | The default. Works for the vast majority of SaaS apps. |
| **Bucket-per-tenant** | Physical (S3 ACL boundary) | Moderate | Compliance pushes back on "one bucket"; large/diff-budget tenants |
| **Account-per-tenant** | AWS-account boundary | Expensive | Strict regulatory regimes (HIPAA per-customer agreements, etc.) |

Pick the cheapest pattern that satisfies your compliance requirements. Migrating from prefix to bucket later is mechanical (a key rename + provider re-wire); going the other way is rarely needed.

## Prefix-per-tenant

The simple, scalable default. Every key starts with the tenant id:

```
acme/avatars/u_1.png
acme/reports/q1.pdf
acme/uploads/01J.../report.bin
contoso/avatars/u_42.png
contoso/reports/q1.pdf
```

Your app enforces the boundary — controllers prepend the tenant id before calling `Storage` methods, never accept a raw path from the user.

### Wrapping Storage with a tenant-aware helper

The cleanest pattern is a request-scoped `TenantStorage` that wraps the `Storage` token and prepends the tenant id automatically:

```ts
// app/Services/tenant_storage.ts
import { inject } from '@strav/kernel'
import { Storage, type PutOptions, type ListOptions, type ListResult } from '@strav/storage'
import { TenantManager } from '@strav/database'

@inject()
export class TenantStorage {
  constructor(
    private readonly storage: Storage,
    private readonly tenants: TenantManager,
  ) {}

  put(path: string, contents: Parameters<Storage['put']>[1], options?: PutOptions) {
    return this.storage.put(this.scope(path), contents, options)
  }

  get(path: string) {
    return this.storage.get(this.scope(path))
  }

  delete(path: string) {
    return this.storage.delete(this.scope(path))
  }

  list(options: ListOptions = {}): Promise<ListResult> {
    const tenantPrefix = `${this.currentTenant()}/`
    return this.storage.list({
      ...options,
      prefix: options.prefix !== undefined ? this.scope(options.prefix) : tenantPrefix,
    })
  }

  signedUrl(path: string, options: Parameters<Storage['signedUrl']>[1]) {
    return this.storage.signedUrl(this.scope(path), options)
  }

  publicUrl(path: string): string {
    return this.storage.publicUrl(this.scope(path))
  }

  private scope(path: string): string {
    return `${this.currentTenant()}/${path}`
  }

  private currentTenant(): string {
    const id = this.tenants.current()
    if (id === null) throw new Error('TenantStorage used outside a tenant scope.')
    return id
  }
}
```

Controllers inject `TenantStorage` instead of `Storage`. The tenant prefix is applied transparently, and the `currentTenant()` check throws loudly if you accidentally call it outside a `TenantManager.withTenant(...)` scope.

```ts
@inject()
class ReportsController {
  constructor(private readonly storage: TenantStorage) {}

  async upload(ctx: HttpContext): Promise<Response> {
    // No need to prepend the tenant — TenantStorage handles it.
    const key = `reports/${ulid()}.pdf`
    await this.storage.put(key, await ctx.request.raw.arrayBuffer())
    return ctx.response.json({ key })
  }
}
```

### What the prefix should be

Use the tenant id, not the tenant slug or domain — slugs change when customers rebrand, ids don't. ULIDs work; integer IDs work too if that's your tenant table's PK.

```
01HX.../reports/r1.pdf       ← ULID tenant id
42/reports/r1.pdf             ← integer tenant id (smaller keys, sortable)
```

Avoid `tenant_` or other prefixes on the prefix — the tenant id alone is enough, adding `tenant_` just makes every key longer for no information gained.

### When prefix-per-tenant breaks

- **Compliance.** Some regulatory frameworks (HIPAA BAAs, certain government clouds) require that a customer's data live in a physically separate storage bucket with separate access controls. Logical isolation isn't acceptable.
- **Tenant-level rate limits.** S3 limits per-bucket request rates (S3 is fine for most apps; R2 has different limits). If one noisy tenant saturates the shared bucket, the whole app slows down.
- **Different storage classes per tenant.** Enterprise customers want `STANDARD`, indie customers can live with `STANDARD_IA`. The storage class is per-object on S3 — you can set it per-tenant via metadata — but at scale, separate buckets make the billing cleaner.
- **Tenant offboarding.** Deleting all of a tenant's data requires walking every key under the prefix and calling `delete()` on each. Slow for tenants with millions of objects. Bucket-per-tenant collapses this to a single `DeleteBucket` call.

## Bucket-per-tenant

Each tenant gets its own bucket. Your app code picks the bucket at request time based on the current tenant.

The trade-off is operational: creating + tearing down buckets is an admin operation in your tenant-provisioning flow, not something the user-request path does.

```ts
// app/Services/tenant_storage_factory.ts
import { inject } from '@strav/kernel'
import { S3Storage } from '@strav/storage/s3'
import { TenantManager } from '@strav/database'

@inject()
export class TenantStorageFactory {
  private readonly cache = new Map<string, S3Storage>()

  constructor(private readonly tenants: TenantManager) {}

  forCurrent(): S3Storage {
    const tenantId = this.tenants.current()
    if (tenantId === null) throw new Error('No tenant scope.')
    const cached = this.cache.get(tenantId)
    if (cached !== undefined) return cached
    const driver = new S3Storage({
      bucket: `app-${tenantId}`,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      publicBase: `https://app-${tenantId}.s3.amazonaws.com`,
    })
    this.cache.set(tenantId, driver)
    return driver
  }
}
```

Controllers ask the factory for a per-tenant `Storage`:

```ts
@inject()
class ReportsController {
  constructor(private readonly factory: TenantStorageFactory) {}

  async upload(ctx: HttpContext): Promise<Response> {
    const storage = this.factory.forCurrent()
    await storage.put(`reports/${ulid()}.pdf`, await ctx.request.raw.arrayBuffer())
    return ctx.response.json({ ok: true })
  }
}
```

### Provisioning the bucket

Bucket creation happens in your tenant signup flow, not on first-write. The signup transaction looks like:

1. Insert the tenant row.
2. Provision the storage bucket (via the AWS SDK or — for simple cases — Bun's S3Client with admin credentials and a low-level `send('PUT', ...)` against `s3://app-<tenant-id>/`).
3. Apply the bucket policy (deny public access by default, allow the app role).
4. Commit.

If bucket provisioning fails, roll back the tenant row — otherwise you have a tenant who can't store files.

### Bucket naming

S3 bucket names must be globally unique (across all AWS accounts) and follow DNS-name rules (lowercase, alphanumeric + hyphens, ≤63 chars). Prefix them so your app's buckets don't collide with other apps:

```
myapp-tenant-acme           ← good
myapp-tenant-01hxxx...      ← good (ULID lowercased works)
acme                        ← bad (someone else will own this)
```

R2 + Tigris bucket names have different rules (often less restrictive); B2 is similar to S3. The framework doesn't impose a naming policy — pick one that fits your provider.

## Cross-tenant operations

Sometimes you legitimately need to operate on data outside the current tenant — admin tooling, support workflows, the "see another tenant's view" feature.

For **prefix-per-tenant**, use the base `Storage` token directly (not the wrapped `TenantStorage`):

```ts
@inject()
class AdminToolsController {
  constructor(private readonly storage: Storage) {}

  async tenantUsage(tenantId: string): Promise<UsageStats> {
    let totalBytes = 0
    let cursor: string | undefined
    do {
      const result = await this.storage.list({
        prefix: `${tenantId}/`,
        recursive: true,
        limit: 1000,
        after: cursor,
      })
      for (const entry of result.entries) {
        totalBytes += entry.size ?? 0
      }
      cursor = result.cursor
    } while (cursor !== undefined)
    return { tenantId, totalBytes }
  }
}
```

The pattern is: lean on the prefix structure you already enforce. `list({ prefix: '<tenant-id>/' })` gives you everything that tenant owns.

For **bucket-per-tenant**, the admin tooling needs admin credentials with `s3:ListBucket` across every tenant bucket — a separate IAM role with broader permissions than your app's main role. The factory grows a `forTenant(tenantId)` method that takes the id explicitly:

```ts
forTenant(tenantId: string): S3Storage {
  // Uses the admin credentials, not the app's request-time creds.
  return new S3Storage({
    bucket: `app-${tenantId}`,
    accessKeyId: process.env.S3_ADMIN_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_ADMIN_SECRET_ACCESS_KEY ?? '',
    // ...
  })
}
```

Audit every call to `forTenant(...)` — admin operations on other tenants' data are sensitive.

## Tenant deletion

GDPR right-to-erasure means you need to actually delete a tenant's data, not just mark them inactive.

**Prefix-per-tenant** — walk + delete:

```ts
async purgeTenant(tenantId: string): Promise<void> {
  let cursor: string | undefined
  do {
    const result = await this.storage.list({
      prefix: `${tenantId}/`,
      recursive: true,
      limit: 1000,
      after: cursor,
    })
    for (const entry of result.entries) {
      if (entry.isDirectory) continue
      await this.storage.delete(entry.path)
    }
    cursor = result.cursor
  } while (cursor !== undefined)
}
```

Run this as a queue job, not inline — deleting millions of objects takes minutes. Set the job's `maxAttempts` higher than normal so a transient S3 hiccup doesn't leave half-deleted data.

**Bucket-per-tenant** — empty the bucket, then delete it:

S3 doesn't have a single "delete bucket and all contents" API; you have to empty it first. The AWS CLI's `aws s3 rb s3://bucket --force` does this; Bun's S3Client doesn't expose it directly. For most apps with bucket-per-tenant, dropping to the AWS SDK in your tenant-deletion job is fine — that path runs rarely.

## Combining tenancy with the database layer

`@strav/database`'s `TenantManager` already scopes Postgres queries via session variables (RLS). The `TenantStorage` wrapper from this guide does the same thing for object storage. Apps that use both:

```ts
// In your tenant middleware:
await tenants.withTenant(tenantId, async () => {
  // Postgres queries scope to this tenant via RLS.
  // TenantStorage prepends the tenant prefix.
  // Both lean on the same `tenants.current()` call.
  return next(ctx)
})
```

Keep the boundary unified — one `withTenant` block scopes everything for the duration of the request. If you ever find yourself reaching for `tenants.current()` in multiple unrelated services, that's a smell that the middleware boundary slipped.

## Don't put the tenant id in publicUrl

If you serve public assets, prefixing with the tenant id leaks the tenant id into URLs:

```
https://cdn.acme-app.com/01HXXXX/avatars/u_1.png
                          ^^^^^^^ — visible to anyone with the URL
```

For most apps this is fine — tenant ids aren't secrets. For apps where it matters (the tenant id reveals the customer's identity, or you white-label per tenant), hash the tenant id into the URL prefix:

```ts
const hash = createHash('sha256').update(tenantId + URL_HASH_SECRET).digest('hex').slice(0, 16)
const publicKey = `${hash}/avatars/u_1.png`
await storage.put(publicKey, body, { visibility: 'public' })
```

The hash is deterministic (same tenant → same hash, so URLs are stable) but reveals nothing about the underlying id. Pair with a secret salt so an attacker can't rainbow-table the hash back to a tenant id list.

For private content this doesn't matter — signed URLs hide the path inside the signature anyway.
