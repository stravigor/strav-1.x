# Repositories — Model + Repository + QueryBuilder

Per `spec/orm-and-repositories.md`: data access is **explicit and injectable**. There is no `User.find(id)` or `user.save()`. Apps define a `Model` (plain typed class) plus a `Repository<TModel>` (injectable data-access object) and inject the repository wherever they need it.

## The three layers

| Layer | Role |
|---|---|
| **Schema** (`defineSchema(...)`) | Single source of truth — table name, fields, archetype, tenancy |
| **Model** | Plain typed entity. Fields + (eventually) decorators. No statics. No `save()`. No connection. |
| **Repository<TModel>** | Injectable. Holds CRUD + query builder + resource-specific finders |

The Model and the Repository both reference the same Schema. The Repository's `find`/`create`/`update`/etc. use the schema to know which table to hit; the Model declares it via `static schema = …` so the Repository can hydrate rows onto fresh instances.

## Anatomy

### Schema (already covered in the schemas guide)

```ts
// database/schemas/user_schema.ts
import { Archetype, defineSchema } from '@strav/database'

export const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').max(320).unique()
  t.string('name')
  t.timestamps()
})
```

### Model

```ts
// app/models/user.ts
import { Model } from '@strav/database'
import { userSchema } from '../../database/schemas/user_schema.ts'

export class User extends Model {
  static override readonly schema = userSchema

  id!: string
  email!: string
  name!: string
  created_at!: Date
  updated_at!: Date

  // Optional computed accessor
  get displayName(): string {
    return this.name || this.email
  }
}
```

Fields are plain class properties. `static schema = …` is the contract — Repository reads it to know which schema applies.

Decorators (`@encrypt`, `@hidden`, `@cast`, `@ulid`) land with the encryption + serialization slice; for now the Model is a pure data holder and the Repository hydrates by copying schema-declared columns onto a fresh instance.

### Repository

```ts
// app/repositories/user_repository.ts
import { inject } from '@strav/kernel'
import { type ModelClass, Repository } from '@strav/database'
import { User } from '../models/user.ts'
import { userSchema } from '../../database/schemas/user_schema.ts'

@inject()
export class UserRepository extends Repository<User> {
  static override readonly schema = userSchema
  static override readonly model: ModelClass = User as unknown as ModelClass

  // Resource-specific finder
  async findByEmail(email: string): Promise<User | null> {
    return this.query().where({ email }).first()
  }
}
```

The `@inject()` decorator on the subclass lets the container resolve the `PostgresDatabase` the base constructor needs.

The `static model` cast (`as unknown as ModelClass`) is a TS variance workaround — the base `Repository<TModel>` declares `static model: ModelClass<Model>` and TS doesn't auto-widen `ModelClass<User>` to that. Functionally identical; the cast lives at exactly one spot per Repository.

### Use it

```ts
import { inject } from '@strav/kernel'

@inject()
export class UserController {
  constructor(private users: UserRepository) {}

  async show(ctx: HttpContext): Promise<Response> {
    const user = await this.users.findOrFail(ctx.request.params.id)
    return ctx.response.ok(user)
  }

  async store(ctx: HttpContext): Promise<Response> {
    const body = (await ctx.request.json()) as Partial<User>
    const user = await this.users.create(body)
    return ctx.response.created(user)
  }
}
```

No prior `app.singleton(UserRepository)` registration is needed — the container `make()`s the repository on demand via `@inject()` metadata, walking the constructor's resolved `PostgresDatabase` dep through the binding `DatabaseProvider` installed.

## Repository surface

```ts
class Repository<TModel> {
  find(id): Promise<TModel | null>
  findOrFail(id): Promise<TModel>                          // throws NotFoundError
  findMany(ids: readonly (string | number)[]): Promise<TModel[]>
  first(): Promise<TModel | null>
  all(): Promise<TModel[]>

  create(attrs: Partial<TModel>): Promise<TModel>
  update(model: TModel, changes: Partial<TModel>): Promise<TModel>
  delete(model: TModel): Promise<void>

  query(): QueryBuilder<TModel>

  exists(where: Partial<TModel>): Promise<boolean>
  count(where?: Partial<TModel>): Promise<number>
}
```

### What's automatic

- **ULID on create.** If the schema declares `t.id()` (ULID kind) and the caller didn't supply `attrs.id`, the Repository mints one via `ulid()`. UUID schemas (`t.uuid()`) get `crypto.randomUUID()`.
- **`updated_at` bump on update.** If the schema declared `t.timestamps()` and the caller didn't supply `changes.updated_at`, the SQL appends `SET updated_at = now()`.
- **`created_at` / `updated_at` on create.** Not bound at all when absent from attrs — the schema's `DEFAULT now()` fires. One source of time truth (the DB), no clock skew between app and DB.
- **`RETURNING *` on `create` / `update`.** The Repository hydrates the returned row, so callers get back the canonical state (including any DB-defaulted columns) without a second `find()`.

### Lifecycle events

The Repository emits six events per resource on the `EventBus`:

```
<resource>.creating  (cancelable) — fires before INSERT
<resource>.created                — fires after INSERT succeeds
<resource>.updating  (cancelable) — fires before UPDATE
<resource>.updated                — fires after UPDATE succeeds
<resource>.deleting  (cancelable) — fires before DELETE
<resource>.deleted                — fires after DELETE succeeds
```

`<resource>` is the schema name (snake_case, singular — so `user`, `order_item`, `access_token`). The `.<verb>ing` events are cancelable: a throwing listener stops the SQL from running and the Repository method rejects with the listener's error. The `.<verb>ed` events run after the SQL succeeds; listener throws don't roll anything back (they get logged via the bus's default handler).

```ts
// In a provider's boot():
const events = app.resolve(EventBus)

events.on('user.creating', ({ attrs }: RepositoryCreatingEvent<User>) => {
  if (BANNED_DOMAINS.some(d => (attrs.email ?? '').endsWith(d))) {
    throw new ValidationError('email-domain-banned')
  }
})

events.on('user.created', async ({ model }: RepositoryCreatedEvent<User>) => {
  await searchIndex.add(model)
})

events.on('user.deleted', async ({ model }: RepositoryDeletedEvent<User>) => {
  await searchIndex.remove(model.id)
})
```

The `EventBus` is injected into Repository via `@inject()` — the kernel's `Application` registers it as a singleton in its constructor. Subclasses that want events declare it on their constructor:

```ts
@inject()
export class UserRepository extends Repository<User> {
  static schema = userSchema
  static model = User
  constructor(db: PostgresDatabase, events: EventBus) {
    super(db, events)
  }
}
```

Construct a repo without events (tests, dev scripts) and the CRUD methods stay quiet — no events fire, no listeners needed.

**Inside `UnitOfWork.run` (or `TenantManager.withTenant`), post-events queue.** They flush after the user's callback returns but before the transaction commits — a throw drops the queue, so `.created` only fires for transactions that committed. Cancelable `<verb>ing` events fire immediately around each Repository call regardless. See [`unit_of_work.md`](./unit_of_work.md) for the full transactional semantics.

### Transaction scoping — `{ tx? }`

Every CRUD method takes an optional `{ tx? }` as its final arg. Inside `UnitOfWork.run(fn)` (or `TenantManager.withTenant(...)`) you don't need to pass it — the transaction's executor flows through `AsyncLocalStorage` and Repository picks it up automatically:

```ts
await uow.run(async () => {
  const user = await users.create({ email: 'a@b.com' })   // ← uses the tx
  await profiles.create({ user_id: user.id, name: 'Alice' })   // ← same tx
})
```

For paths that bypass `UnitOfWork` (raw `Database.transaction(fn)` or any custom tx flow), pass `{ tx }` explicitly:

```ts
await db.transaction(async (tx) => {
  await users.create({ email: 'a@b.com' }, { tx })
  await profiles.create({ user_id, name: 'Alice' }, { tx })
})
```

Explicit `opts.tx` always wins over the ambient ALS scope. See [`unit_of_work.md`](./unit_of_work.md) for the full transactional flow.

### What's NOT automatic (yet)

- **Soft-delete integration** — `t.softDeletes()` adds the column but `delete()` still hard-deletes. `withTrashed()` / `onlyTrashed()` on the query builder land with the soft-delete slice.
- **Relationships + eager loading** (`.with('relation')`) — the relationships slice.
- **Pagination helpers** (`.paginate`, `.cursorPaginate`) — same slice.

## QueryBuilder

`Repository#query()` returns a `QueryBuilder<TModel>`. Foundation slice: WHERE / ORDER BY / LIMIT / OFFSET / SELECT plus terminal methods.

```ts
const users = await this.users.query()
  .where('email', 'like', '%@acme.com')
  .where('created_at', '>=', cutoff)
  .orderBy('created_at', 'desc')
  .limit(50)
  .get()
```

### Modifiers (each returns a fresh builder — chains are immutable)

```ts
.select('id', 'email')                                  // default is every schema column
.where(col, value)                                       // equality
.where(col, op, value)                                   // = | <> | < | <= | > | >= | like | ilike
.where({ col1: v1, col2: v2 })                           // object form — chained equalities
.whereIn(col, [v1, v2])
.whereNotIn(col, [v1])
.whereNull(col)
.whereNotNull(col)
.orderBy(col, 'asc' | 'desc')
.limit(n)
.offset(n)
```

### Terminals

```ts
.get(): Promise<TModel[]>                                // every matching row
.first(): Promise<TModel | null>                         // first (implicit LIMIT 1)
.firstOrFail(): Promise<TModel>                          // throws NotFoundError
.count(): Promise<number>                                // SELECT COUNT(*) — ignores LIMIT
.exists(): Promise<boolean>                              // SELECT 1 ... LIMIT 1
.pluck<T>(col): Promise<T[]>                             // one column
```

`.toSql()` returns `{ sql, params }` — useful when integrating with raw `db.query()` or for debugging.

## Repository hooks (deferred)

The spec describes lifecycle events the Repository emits on the application EventBus (`<resource>.creating` / `.created` / etc., with cancelable semantics on the `creating`/`updating`/`deleting`/`restoring` variants). That's a separate slice — it requires wiring the EventBus through the constructor, defining a stable event-name convention, and figuring out transactional flush semantics ("queue events until commit, flush on success, drop on rollback").

For now, do side effects from the controller after the Repository call. The hooks slice will move them into a single event listener that fires consistently regardless of caller.

## Testing repositories

`Repository` takes `PostgresDatabase` directly for `@inject()` compatibility. In tests, build a fake that satisfies the `DatabaseExecutor` surface and cast — Repository never calls `PostgresDatabase`-specific methods (`transaction` / `close` / `raw`) within CRUD:

```ts
import type { PostgresDatabase } from '@strav/database'

class FakeDb {
  // Implement query / queryOne / execute
  async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> { … }
  async queryOne<T>(sql: string, params?: readonly unknown[]): Promise<T | null> { … }
  async execute(sql: string, params?: readonly unknown[]): Promise<number> { … }
}

const repo = new UserRepository(new FakeDb() as unknown as PostgresDatabase)
```

The package's own unit suite (`packages/database/tests/repository.test.ts`) uses this pattern via `FakeUserDb extends InMemoryDatabase` — see it for a complete example. Real Postgres integration tests live with CI setup.

## What the spec promises but isn't here yet

- **`.with('relation')` + relationship definitions on the schema** — the relationships slice.
- **`.paginate(...)` + `.cursorPaginate(...)`** — same slice as relationships.
- **`.withTrashed()` / `.onlyTrashed()` + soft-delete in `delete()`** — soft-delete slice.
- **`.join` / `.leftJoin` / CTEs** — joins + CTEs slice.
- **`@encrypt` / `@hidden` / `@cast` / `@ulid` decorators on the Model** — the serialization slice.
