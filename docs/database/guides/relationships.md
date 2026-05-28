# Relationships + eager loading + pagination

V1 covers the 90% case: declare `hasMany` / `belongsTo` on the schema, eager-load via `.with('relation_name')`, paginate with `.paginate({ page, perPage })`.

## Declaring relations

Relations live on the schema next to the field declarations. They drive `QueryBuilder.with(...)` eager loading — they don't affect DDL emission (FK columns are still declared via `t.reference(...)`).

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
  t.reference('user_id').to(userSchema).onDelete('cascade')
  t.timestamps()
  t.belongsTo(userSchema, { foreignKey: 'user_id', as: 'author' })
})
```

- **`t.hasMany(target, { foreignKey, as? })`** — one-to-many. The parent has many child rows; the child's `foreignKey` column points back to the parent's PK. `as` defaults to the target name; apps usually override to the plural (`as: 'posts'`).
- **`t.belongsTo(target, { foreignKey, as? })`** — the inverse. THIS row carries `foreignKey` pointing at the target's PK. Apps typically pair this with `t.reference(...)` for the column itself.

`target` accepts a `Schema`, anything with a `.name` (the Model class fits), or a raw string.

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

### Cursor pagination is deferred

Cursor pagination (`.cursorPaginate({ after, perPage })`) is faster on large tables and stable under inserts — but it needs an explicit sort-key contract. Lands in a follow-up slice. For V1, offset is enough for most app surfaces; switch to cursor when offset starts hurting (typically past ~10k rows for page-deep queries).

## What's NOT here

Each lands as its own follow-up:

- **Typed Model children** on eager-loaded relations. Today: cast. Tomorrow: a Model registry that lets QueryBuilder hydrate children to the right class.
- **Nested eager loading** (`with('posts.comments')`). V1 is one level deep — for deeper graphs, run two queries (or wait for the syntax).
- **`hasOne`** (one-to-one inverse) and **`belongsToMany`** (many-to-many via pivot). The pivot case needs a pivot-schema declaration; deferred.
- **Lazy loading on Models** (`await user.posts`). Cross-package coupling — Model → Repository. Eager loading is the V1 idiom; lazy is a follow-up if there's demand.
- **Cursor pagination** (`.cursorPaginate`). Needs the sort-key contract.
- **Relation-aware WHERE filters** (`.whereHas('posts', q => q.where('published', true))`). Subquery-style filtering on relations. Lands with the joins/subqueries slice.

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
