# CTEs + UNION

QueryBuilder supports Common Table Expressions and UNION composition. The same builder that handles `WHERE` / `ORDER BY` / `LIMIT` / `.with()` eager loads also emits `WITH` clauses, `WITH RECURSIVE`, `UNION`, and `UNION ALL`. Placeholders renumber automatically across every sub-clause, so apps don't have to manage `$N` ordering by hand.

## `.cte(name, body)`

Attach a CTE to the query. The body is either another `QueryBuilder` (typed) or a raw `{ sql, params }` (escape hatch for shapes the builder can't express). The body's placeholders are compiled into the same param accumulator as the main SELECT, so a CTE that takes `$1` ends up renumbered to whatever offset it needs.

```ts
const sub = postRepo.query()
  .where('published', true)
  .orderBy('created_at', 'desc')
  .limit(100)

const { sql, params } = postRepo.query()
  .cte('recent_posts', sub)
  .from('recent_posts')           // SELECT FROM the CTE, not from "post"
  .where('author_id', userId)
  .toSql()
```

```sql
WITH "recent_posts" AS (
  SELECT … FROM "post" WHERE "published" = $1
  ORDER BY "created_at" DESC LIMIT 100
)
SELECT … FROM "recent_posts" WHERE "author_id" = $2
```

Multiple `.cte(...)` calls compose into one comma-separated WITH clause:

```ts
qb.cte('a', subA).cte('b', subB)
// → WITH "a" AS (...), "b" AS (...) SELECT …
```

### `.from(name)` — read from a CTE

The bound schema still drives the SELECT column list, so the CTE body must return rows shaped like the schema (same column names + types) for `.get()` hydration to work. Apps projecting arbitrary shapes drop down to raw `db.query()`.

## `.cteRecursive(name, body)`

Same as `.cte`, but the WITH clause emits with the `RECURSIVE` keyword. A WITH list containing at least one recursive CTE gets `RECURSIVE` at the list level — that's the Postgres semantic; non-recursive entries in the same list still work.

The recursive term typically joins back against the CTE itself, which the typed builder can't express today. Pass a raw `{ sql, params }` for the body in that case:

```ts
categoryRepo.query()
  .cteRecursive('tree', {
    sql: `
      SELECT id, parent_id, name FROM "category" WHERE parent_id IS NULL
      UNION ALL
      SELECT c.id, c.parent_id, c.name
      FROM "category" c JOIN "tree" t ON c.parent_id = t.id
    `,
    params: [],
  })
  .from('tree')
  .get()
```

## `.union(other)` / `.unionAll(other)`

Combine the result of this builder's SELECT with another. Both branches are wrapped in parentheses so each side's own `ORDER BY` / `LIMIT` applies inside the branch (required by SQL when the branches carry their own sort/limit). The other builder can be a `QueryBuilder` (matching column shape) or a raw `{ sql, params }`.

```ts
const active = leadRepo.query().where('status', 'active').limit(5)
const pending = leadRepo.query().where('status', 'pending').limit(5)

const { sql, params } = active.unionAll(pending).toSql()
// → SELECT … FROM "lead" WHERE "status" = $1 LIMIT 5
//   UNION ALL
//   (SELECT … FROM "lead" WHERE "status" = $2 LIMIT 5)
```

Chained unions compose left-to-right:

```ts
a.union(b).unionAll(c)
// → a UNION (b) UNION ALL (c)
```

### Outer ORDER BY / LIMIT on a union (V1 boundary)

In V1, modifiers applied AFTER `.union(...)` go to the **left** branch (`this`), not the outer composition. To order the combined result, wrap in a CTE and select from it:

```ts
const combined = active.unionAll(pending)
leadRepo.query()
  .cte('all', combined)
  .from('all')
  .orderBy('created_at', 'desc')
  .limit(20)
  .get()
```

## Parameter renumbering

Every sub-builder body — whether typed `QueryBuilder` or raw `{ sql, params }` — has its placeholders renumbered against the shared accumulator at compile time. A raw body that writes `$1, $2` in its SQL but lands as the third element in the chain comes out as `$3, $4`. The corresponding params append in order.

```ts
qb.cte('raw', { sql: 'SELECT id FROM t WHERE col = $1', params: ['x'] })
  .where('email', 'a@b.com')
  .toSql()
// → WITH "raw" AS (SELECT id FROM t WHERE col = $1) SELECT … WHERE "email" = $2
// params: ['x', 'a@b.com']
```

## What's NOT in V1

- **Outer `ORDER BY` / `LIMIT` on a union.** Modifiers go to the left branch; wrap with `.cte()` for outer sort/limit. See above.
- **Aggregation terminals + CTE/UNION.** `count()`, `exists()`, `pluck()`, `paginate()` run against the main builder only — they do not include the WITH clause or unions. Apps needing a count over a CTE'd / union'd result drop down to raw `db.query()`.
- **Typed recursive CTEs.** The recursive term usually needs a JOIN against the CTE itself, which QueryBuilder can't express. Pass the body as raw `{ sql, params }` instead.
- **Eager loading on union results.** `.with(...)` is bound to a single schema's relations; unions across schemas would need a richer Relation contract.
