# Relationships + eager loading + pagination

V1 covers the four relation kinds: `hasMany`, `hasOne`, `belongsTo`, `belongsToMany`. Declare them on the schema, eager-load via `.with('relation_name')`, paginate with `.paginate({ page, perPage })`.

## Declaring relations

Relations live on the schema next to the field declarations. They drive `QueryBuilder.with(...)` eager loading — they don't affect DDL emission (FK columns are still declared via `t.foreign(...)`).

```ts
const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email')
  t.timestamps()
  t.hasMany('post', { foreignKey: 'user_id', as: 'posts' })
})

const postSchema = defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.string('title')
  t.foreign('user_id').to(userSchema).onDelete('cascade')
  t.timestamps()
  t.belongsTo(userSchema, { foreignKey: 'user_id', as: 'author' })
})
```

- **`t.hasMany(target, { foreignKey, as? })`** — one-to-many. The parent has many child rows; the child's `foreignKey` column points back to the parent's PK. `as` defaults to the target name; apps usually override to the plural (`as: 'posts'`).
- **`t.belongsTo(target, { foreignKey?, as?, nullable?, onDelete? })`** — the inverse. THIS row owns the FK; the one call declares **both the FK column AND the relation**. `foreignKey` defaults to `<target>_id`. If you already declared the column via `t.foreign(...)` first (older two-call style), `belongsTo` notices and skips column creation — back-compat is preserved.

```ts
// Recommended one-call form
defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.string('title')
  t.belongsTo(userSchema, { as: 'author' })   // creates user_id + relation
  t.timestamps()
})

// Two-call form (still works; reach for it when the FK column needs flags
// `belongsTo` doesn't surface, or when you want an FK with NO relation):
defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.foreign('user_id').to(userSchema).onDelete('cascade')
  t.belongsTo(userSchema, { foreignKey: 'user_id', as: 'author' })
})
```

`target` accepts a `Schema`, anything with a `.name` (the Model class fits), or a raw string.

### Circular references — use string targets

Two schemas that reference each other can't both import the typed `Schema` object: whichever file gets imported second will see `undefined` for the first one's symbol because the cycle hasn't resolved yet. The fix is to pass the table name as a string on the side declared first — the FK type and the eager-loader resolve against the `SchemaRegistry` at DDL emission / query time, not at schema-build time, so a forward string reference is safe.

```ts
// user_schema.ts
import { Archetype, defineSchema } from '@strav/database'

export const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
  // String target — `postSchema` doesn't exist yet at module-eval time.
  t.hasMany('post', { foreignKey: 'user_id', as: 'posts' })
})
```

```ts
// post_schema.ts
import { Archetype, defineSchema } from '@strav/database'
import { userSchema } from './user_schema.ts'

export const postSchema = defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.string('title')
  // Typed target — userSchema was imported above.
  t.belongsTo(userSchema, { as: 'author' })
  t.timestamps()
})
```

The string side gives up compile-time spell-checking on the target name; the typed side keeps it. Both work the same at runtime — `app.has(SchemaRegistry)` resolves both `'user'` and `'post'` by name when DDL or `.with(...)` needs the other schema's PK type.

For deeper cycles (three-way or more), use string targets on every side — they're symmetric. The registry check at boot (`validateTenantRegistry` for tenancy; the FK type resolver for everything else) surfaces typos as `'unknown schema "<name>"'` errors at app start, not in production.

## Eager loading via `.with(...)`

`Repository.query().with('relationName')` runs the main query, then issues one batched SELECT per relation, groups by foreign key, and attaches the children to each parent.

```ts
const users = await this.users.query().with('posts').get()
// users[0].posts is an array of child rows
// users[1].posts is its own array
```

The "one query per relation" property is the N+1 prevention guarantee: regardless of how many parent rows came back, you get exactly two queries total (main + posts). For N relations, N+1 queries.

```ts
const posts = await this.posts.query().with('author').get()
// posts[0].author is a single row (or null)
```

`belongsTo` deduplicates foreign-key values before the lookup: if 1000 posts reference the same 50 users, the author query has 50 placeholders, not 1000.

### Multiple relations

```ts
await this.users.query().with('posts', 'comments').get()
// Or chain:
await this.users.query().with('posts').with('comments').get()
```

Each relation runs one batched SELECT; the chained form is equivalent.

### `.with(...)` flows through every terminal

```ts
const one = await this.users.query().with('posts').first()
const many = await this.users.query().with('posts').get()
const page = await this.users.query().with('posts').paginate({ page: 1, perPage: 20 })
```

Eager loading attaches before the result returns. The page result's `data` rows already have their `posts` populated.

## What eager-loaded children look like

V1 attaches children as **plain `Record<string, unknown>`** objects, not Model instances:

```ts
const users = await this.users.query().with('posts').get()
// users: User[] (typed)
// users[0].posts: Record<string, unknown>[] (NOT Post[])

// Apps that need typed children cast:
const posts = users[0]?.posts as Post[]
```

The cast is fine for property access (the row has all the schema's columns), but methods on the Model class (e.g., a `Post.isPublished()` instance method) won't work — the value is a plain object, not a class instance.

Typed-Model children are a follow-up slice: it needs a "Model registry" alongside the SchemaRegistry so the QueryBuilder can look up the right ModelClass per relation target. For V1, plain rows are the trade-off.

## Pagination

Offset pagination via `.paginate({ page, perPage })`:

```ts
const result = await this.users.query()
  .orderBy('created_at', 'desc')
  .paginate({ page: 2, perPage: 25 })

// result:
// {
//   data: User[]      ← page 2's rows (with any .with(...) eager-loads applied)
//   total: 137        ← total rows matching the query
//   page: 2
//   perPage: 25
//   totalPages: 6     ← Math.ceil(total / perPage)
// }
```

Runs two queries in parallel:
1. The main SELECT with `LIMIT 25 OFFSET 25`
2. A `SELECT COUNT(*) FROM "user" WHERE …` for the total

Both respect every WHERE / soft-delete / tenant predicate the builder has accumulated.

### Invalid input

`page` and `perPage` must be positive integers. Floats / 0 / negatives throw at the API boundary — apps typically clamp values from a query string before calling.

```ts
const page = Math.max(1, parseInt(ctx.request.input('page')) || 1)
const perPage = Math.max(1, Math.min(100, parseInt(ctx.request.input('per_page')) || 20))
const result = await users.query().paginate({ page, perPage })
```

### Cursor pagination — `.cursorPaginate({ perPage, after?, before? })`

Faster than offset at any depth (uses the index, doesn't scan + discard `OFFSET` rows) and stable under concurrent inserts. Reads the sort key from a prior `.orderBy(col, dir)` on the builder — exactly one `.orderBy(...)` call is required; the PK is the auto-tiebreaker for rows sharing the same sort value.

```ts
const first = await postRepo.query()
  .where('published', true)
  .orderBy('created_at', 'desc')
  .cursorPaginate({ perPage: 20 })

// first.data:        Post[]      ← page 1's rows
// first.hasMore:     boolean     ← is there another page in this direction
// first.nextCursor:  string|null ← pass back as `after` to fetch the next page
// first.prevCursor:  string|null ← `before` for the previous page (after navigating forward at least once)

if (first.hasMore) {
  const next = await postRepo.query()
    .where('published', true)
    .orderBy('created_at', 'desc')
    .cursorPaginate({ perPage: 20, after: first.nextCursor! })
}
```

The cursor is an opaque base64url-encoded `{ v: sortValue, i: pkValue }`. `Date` sort values encode as ISO strings + roundtrip through the WHERE params correctly. Pass `before` (mutually exclusive with `after`) for backward pagination — the builder internally reverses the ORDER BY direction and re-reverses the result so the caller still sees the natural sort order.

**V1 boundaries**:
- Cursor pagination does NOT compose with `.cte(...)` / `.union(...)` — throws if either is set. Use `.paginate({ page, perPage })` for those cases.
- Multi-column sort keys (`.orderBy('a').orderBy('b')`) aren't supported — throws. Compose the secondary key into a single column expression or wait for the composite-cursor follow-up.

### `.chunk(perPage, fn)` — stream the whole result set

Cursor-paginated under the hood. Walks every page, calling `fn(rows)` for each. Returning `false` from `fn` short-circuits cleanly; throws propagate. Returns the total rows processed.

```ts
const total = await postRepo.query()
  .where('archived', false)
  .orderBy('id')
  .chunk(500, async (posts) => {
    for (const post of posts) await reindex(post)
  })
```

Same `.orderBy(col, dir)` requirement as `.cursorPaginate`. Safe on tables of any size — no `OFFSET` scan and no risk of skipping or duplicating rows under concurrent inserts.

## `hasOne` — single-row child

Same wire shape as `hasMany` (the child carries the `foreignKey` back-reference), but the eager-load result is the single matching row or `null` instead of an array. Useful for 1:1 records split into a separate table — a user's profile, a post's draft snapshot.

```ts
const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
  t.hasOne('profile', { foreignKey: 'user_id', as: 'profile' })
})

const profileSchema = defineSchema('profile', Archetype.Entity, (t) => {
  t.id()
  t.foreign('user_id').to(userSchema)
  t.string('bio')
  t.timestamps()
})

const users = await userRepo.query().with('profile').get()
// users[0].profile → { id, user_id, bio, ... } | null
```

If duplicate FK rows exist (data anomaly — fix at the schema level with a unique index on `profile.user_id`), the first match wins. The eager-loader doesn't throw; debugging is easier when you can see the data.

## `belongsToMany` — many-to-many through a pivot

The pivot table is its own schema. The `belongsToMany` relation only declares how to join through it — the pivot's columns + indices live in a separate `defineSchema` call.

```ts
const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
  t.belongsToMany('role', {
    pivot: 'user_role',
    parentKey: 'user_id',
    targetKey: 'role_id',
    as: 'roles',
  })
})

const roleSchema = defineSchema('role', Archetype.Entity, (t) => {
  t.id()
  t.string('name').unique()
  t.timestamps()
})

// Pivot — declare it as a normal schema so DDL, migrations, and indexes
// are visible in one place. Naming convention: <a>_<b> alphabetised.
const userRoleSchema = defineSchema('user_role', Archetype.Entity, (t) => {
  t.id()
  t.foreign('user_id').to(userSchema)
  t.foreign('role_id').to(roleSchema)
  t.timestamps()
})

const users = await userRepo.query().with('roles').get()
// users[0].roles → [{ id, name, ... }, ...]
```

The eager-loader runs ONE query — a JOIN against the pivot — instead of two round-trips. The pivot's `parentKey` column surfaces internally under a synthetic `__strav_parent_key` alias used to bucket target rows by parent, then the alias is stripped before the row reaches your code.

Index the pivot on `(parent_key, target_key)` (or just `parent_key` alone) so the eager-load query is index-only.

## What's NOT here

Each lands as its own follow-up:

- **Typed Model children** on eager-loaded relations. Today: cast. Tomorrow: a Model registry that lets QueryBuilder hydrate children to the right class.
- **Nested eager loading** (`with('posts.comments')`). V1 is one level deep — for deeper graphs, run two queries (or wait for the syntax).
- **Lazy loading on Models** (`await user.posts`). Cross-package coupling — Model → Repository. Eager loading is the V1 idiom; lazy is a follow-up if there's demand.
- **Composite-cursor pagination** (multi-column sort keys). V1 takes one column from `.orderBy(...)` + the PK as tiebreaker.
- **Relation-aware WHERE filters** (`.whereHas('posts', q => q.where('published', true))`). Subquery-style filtering on relations. Distinct from the QB joins shipped today (those filter on already-joined tables; `.whereHas` would derive the subquery from the relation declaration).

## Wiring

`QueryBuilder.with(...)` needs a `SchemaRegistry` to look up the target schema. Repository threads it through automatically — apps that want eager loading construct the Repository with the registry (or let `@inject()` resolve it):

```ts
// Via the container (typical):
@inject()
class UserRepository extends Repository<User> {
  static schema = userSchema
  static model = User
  constructor(db: PostgresDatabase, events: EventBus, registry: SchemaRegistry) {
    super(db, events, registry)
  }
}
```

Without a registry, `.with(...)` throws at runtime with a clear error message. Tests that don't exercise eager loading pass `undefined` (or omit the param entirely).
