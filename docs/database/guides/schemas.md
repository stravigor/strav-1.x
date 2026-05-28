# Schemas — single source of truth for tables

`defineSchema(name, archetype, builder, opts?)` produces an immutable `Schema` value that the migration runner, the future query builder, and the future Repository / Model layer all read from. The schema lives in one file per table at `database/schemas/<name>_schema.ts`.

## Anatomy

```ts
// database/schemas/user_schema.ts
import { Archetype, defineSchema } from '@strav/database'

export const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()                                            // ULID primary key
  t.string('email').max(320).unique()
  t.string('name')
  t.timestamp('email_verified_at').nullable()
  t.softDeletes()
  t.timestamps()
}, {
  // optional tenancy flags
  // tenanted: true,
})
```

A few rules:

- **`name` is the table name.** Snake-case singular by convention; the framework doesn't pluralize.
- **Archetype is meaningful.** Different archetypes get different framework defaults later (events get `created_at` only; references get a slug + cache hint, etc.).
- **Fields are ordered.** The migration runner emits columns in declaration order so generated SQL is auditable.
- **The returned `Schema` is deep-frozen.** Don't try to mutate `.fields[i]` — it won't take.

## Archetypes

| Archetype | Use for | Examples |
|---|---|---|
| `Entity` | top-level mutable resources with identity | `User`, `Order`, `Project` |
| `Attribute` | data owned by another entity | `UserProfile`, `OrderShippingAddress` |
| `Reference` | lookup table; small, often cached | `Country`, `Currency` |
| `Event` | append-only, immutable | `LoginEvent`, `PaymentReceived` |
| `Configuration` | singleton settings | `SystemSettings` |

Use the right archetype — later milestones specialize on it (e.g., `Event` archetypes will get `created_at` automatically and reject `updated_at` / `deleted_at`).

## Field types

### Identity

```ts
t.id()                  // ULID — char(26), name 'id' (recommended)
t.uuid()                // UUID variant
t.bigSerial()           // auto-increment bigint
t.tenantedBigSerial()   // per-tenant auto-increment bigint — DEFERRED (see below)
```

ULID is the default. Lexicographically sortable, 26-char, secret-scanner-friendly. UUID is the alternative for external interop.

**No `t.serial()` (32-bit int).** Intentionally omitted — bigint-by-default avoids the painful overflow migration that 32-bit `serial` PKs eventually force (Postgres `serial` tops out at ~2.1 billion). `bigSerial` is the only auto-increment kind Strav ships; choose ULID if you don't need a numeric PK.

**`t.tenantedBigSerial()` ships per-tenant sequencing on `tenanted: true` schemas.** The DDL emitter wires:
- the column as `bigint NOT NULL DEFAULT 0` (no inline `PRIMARY KEY`),
- a composite `PRIMARY KEY (tenant_id, id)` so id values can repeat across tenants,
- a `BEFORE INSERT` trigger that replaces `0` with the next-id allocated from a shared `_strav_tenant_sequences` counter table (idempotent — re-running migrations is safe),
- the same RLS plumbing every tenanted schema gets.

Each tenant's ids start at 1 and increment independently — Tenant A's `ledger` rows 1, 2, 3 coexist with Tenant B's `ledger` rows 1, 2 in the same table without collision. Outside a `tenanted: true` schema, `t.tenantedBigSerial()` still emits as `bigint NOT NULL DEFAULT 0` but without the trigger / composite PK — the per-tenant sequencing requires the tenant FK to key off, so non-tenanted use is the degraded "just a numeric column" mode. For tenanted schemas where you don't need per-tenant numeric ids, **prefer `t.id()` (ULID)** — globally unique, no trigger.

### Scalars

```ts
t.string('email').max(320)
t.text('body')
t.integer('count').default(0)
t.boolean('is_active').default(true)
t.decimal('amount', 12, 2)              // precision, scale
t.json<MyShape>('metadata')             // generic for downstream Model typing
t.timestamp('paid_at').nullable()       // timestamptz by default
t.timestamp('local_due', { withTimezone: false })
t.enum('status', ['draft', 'paid', 'refunded'])
t.encrypted('ssn')                      // bytea column; pair with `@encrypt` on the Model side
```

### References

```ts
t.reference('user_id').to(userSchema).onDelete('cascade')
t.reference('account_id').to('account').onDelete('restrict')   // string also works
```

Defaults: `onDelete: 'restrict'`. The migration runner will (in the next slice) emit `FOREIGN KEY ... REFERENCES ... ON DELETE ...` automatically. Today, hand-write the FK in the migration if you need it.

## Modifiers

Chainable on every field:

```ts
.nullable()      // allow NULL (default is NOT NULL)
.notNull()       // explicit NOT NULL — for clarity in DSL
.unique()        // UNIQUE constraint
.default(value)  // literal: .default(0), .default(true)
.default({ sql: 'now()' })   // SQL expression: emitted verbatim
```

`.default({ sql: '…' })` is the escape hatch when you need server-side expressions (`now()`, `gen_random_uuid()`, etc.). Plain literals are quoted appropriately.

## Composite helpers

```ts
t.timestamps()    // created_at + updated_at, both NOT NULL DEFAULT now()
t.softDeletes()   // deleted_at, nullable
```

Both are **idempotent** — calling twice within one `defineSchema` call adds nothing. Good for DSL consistency when extending shared mixins later.

## Tenancy flags

```ts
// The registry table — typically your `tenant` schema.
defineSchema('tenant', Archetype.Entity, (t) => {
  t.id()
  t.string('name')
}, { tenantRegistry: true })

// A tenant-scoped table — RLS-enforced (when migration emission lands).
defineSchema('lead', Archetype.Entity, (t) => {
  t.id()
  t.string('email')
}, { tenanted: true })
```

`tenantRegistry` and `tenanted` are **mutually exclusive** — a registry table can't itself be scoped. `defineSchema` throws on misuse.

`emitCreateTable(schema, { registry })` injects the `<registry>_id` FK column right after the PK and appends `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY <name>_tenant_isolation` referencing `current_setting('app.tenant_id')`. `TenantManager.withTenant(...)` binds that GUC per-transaction; see [`multi_tenancy.md`](./multi_tenancy.md).

## Registering with the SchemaRegistry

Two paths — explicit registration (full control) or auto-discovery (zero per-schema wiring).

### Auto-discovery via `Bun.Glob`

Point `discover()` at a glob and it `import()`s every match, registering every export that satisfies the `Schema` shape. Re-exports of the same schema instance (e.g. through a barrel) are deduplicated by object identity; two different schemas claiming the same name still throw — programmer error.

```ts
// app/providers/schemas_provider.ts
import { type Application, ServiceProvider } from '@strav/kernel'
import { SchemaRegistry } from '@strav/database'

export class SchemasProvider extends ServiceProvider {
  override readonly name = 'schemas'
  override readonly dependencies = ['database']

  override register(app: Application): void {
    app.singleton(SchemaRegistry, () => new SchemaRegistry())
  }

  override async boot(app: Application): Promise<void> {
    await app.resolve(SchemaRegistry).discover('database/schemas/**/*.ts')
  }
}
```

`discover()` accepts a single pattern or an array, plus an optional `{ cwd }` (defaults to `process.cwd()`). Files that export non-Schema values (helpers, type-only re-exports) are silently skipped. The `isSchema(value)` type-guard is exported for apps that want to roll their own discovery loop.

### Explicit registration

When you want full control over what's loaded (or to keep boot synchronous):

```ts
import { userSchema } from '../../database/schemas/user_schema.ts'
import { leadSchema } from '../../database/schemas/lead_schema.ts'

new SchemaRegistry().registerAll([userSchema, leadSchema])
// or one-by-one:
//   registry.register(userSchema).register(leadSchema)
```

The runner, the diff generator, and the Repository layer all resolve `SchemaRegistry` from the container, so the registry is the one place that knows the full set of tables.

## What's NOT here yet

- **Schema-diff migration generator + console commands** (`bun strav make:migration`) — needs `@strav/cli`'s db integration.
