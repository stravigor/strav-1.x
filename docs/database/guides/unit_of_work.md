# Unit of work — transactions, tx-routing, queue-until-commit

`UnitOfWork.run(fn)` is the right way to do anything transactional in a Strav app:

```ts
import { UnitOfWork } from '@strav/database'

const uow = new UnitOfWork(app.resolve(PostgresDatabase), app.resolve(EventBus))

await uow.run(async (tx) => {
  const user = await users.create({ email: 'a@b.com' })
  await profiles.create({ user_id: user.id, name: 'Alice' })
  await audit.create({ subject_id: user.id, action: 'signup' })
})
```

Three things happen behind the scenes:

1. **One Postgres transaction** for everything inside `fn`. Bun.SQL's `begin()` wraps the callback; if `fn` returns, the transaction commits. If `fn` throws, it rolls back.
2. **Repository calls auto-route through `tx`** via AsyncLocalStorage. The `users.create(...)` in the example uses the transaction's executor automatically — apps don't have to thread `tx` through every function call.
3. **Lifecycle post-events queue, flush on commit.** `user.created` / `profile.created` / `audit.created` don't fire while `fn` is running; they fire after `fn` returns but before the implicit COMMIT. If `fn` throws, the queue drops — no side effects fire for a transaction that didn't commit.

This is the spec's "honest side effects" property: the only way a `<resource>.created` event reaches a listener is if the DB actually persisted the row.

## Explicit `{ tx }` parameter

Every Repository CRUD method takes an optional `{ tx }` as its final argument. Most apps don't need it (the ambient ALS does the job), but it's there for the cases where you want explicit control or where the call site is outside any `UnitOfWork.run`:

```ts
await db.transaction(async (tx) => {
  // No UoW.run wrapping — plain Database.transaction(). The Repository
  // doesn't see the ambient scope, so pass tx explicitly:
  await users.create({ email: 'a@b.com' }, { tx })
  await profiles.create({ user_id, name: 'Alice' }, { tx })
})
```

Resolution order inside Repository:

1. Explicit `opts.tx` → used.
2. Ambient `UnitOfWork.run` scope → used.
3. Otherwise → `this.db` (auto-commit per query).

Explicit `tx` overrides the ambient ALS, in case you want one call to route through a different executor inside a UoW (rare, but supported).

## Cancelable vs post events inside a UoW

Lifecycle events split into two groups with different semantics inside a UoW:

| Event | Fires when |
|---|---|
| `<resource>.creating` / `.updating` / `.deleting` (cancelable) | **Immediately**, before the SQL. A throwing listener aborts the SQL and the whole transaction rolls back. |
| `<resource>.created` / `.updated` / `.deleted` (post) | **Queued during `fn`, flushed after `fn` returns.** If `fn` throws → queue drops. |

Queueing cancelable events would defeat the abort-via-throw semantic — they wouldn't run until commit, by which point the SQL has already committed. So `.<verb>ing` always fires synchronously around each Repository call.

Apps that need "fail this whole transaction if a side effect fails" register the side effect on the cancelable `.<verb>ing` event rather than the post-event:

```ts
events.on('user.creating', async ({ attrs }) => {
  // Pre-flight check that touches an external system.
  if (await blocklist.contains(attrs.email)) throw new Error('blocked')
})
```

Listener throws on post-events route through the EventBus's `onListenerError` handler (default: `console.error`). They don't roll back the transaction — by the time post-events flush, the user's callback has already returned. That's intentional: a downstream audit-log failure shouldn't undo a successful user signup.

## Nested `UnitOfWork.run`

```ts
await uow.run(async () => {
  // Repository calls here auto-route to the transaction.

  await uow.run(async () => {
    // Reuses the OUTER transaction — no second BEGIN. The framework
    // doesn't insert a savepoint here; if you need savepoint semantics
    // on a failure inside the inner block, use Postgres SAVEPOINT
    // directly (via tx.execute).
  })

  // Still in the outer transaction; queue events accumulate together.
})
// One transaction. One queue flush. One commit.
```

V1 keeps nested handling simple — both queues merge into the outer one, one transaction wraps everything. Apps that want isolated nested transactions (savepoints) reach for the driver's lower-level API explicitly.

## Multi-tenant transactions

`TenantManager.withTenant(id, fn)` is built on top of `UnitOfWork.run` — it opens the same kind of transaction, sets `app.tenant_id`, and inherits all the auto-routing + queue-until-commit semantics:

```ts
await tenants.withTenant(currentUserTenantId, async () => {
  // Repository calls here route through the tenant-scoped tx.
  // RLS policies see the bound tenant. Post-events queue + flush
  // on commit. Throws roll back the transaction AND drop the queue.
  await orders.create({ ... })
  await audit.create({ action: 'order.placed', ... })
})
```

`withoutTenant(fn)` is the same shape without the `set_config` — for admin / migration paths against a `BYPASSRLS` connection.

## Caveats

- **The framework doesn't open savepoints for nested `run`s.** Inner failures roll back the whole outer transaction. Apps that want fine-grained rollback within a transaction use `tx.execute('SAVEPOINT ...')` etc. by hand.
- **Repository auto-routing only sees `UnitOfWork.run` scopes.** If you call `db.transaction(fn)` directly (without wrapping in UoW.run), the Repository inside won't see the ambient scope — pass `{ tx }` explicitly. Apps that prefer the lower-level primitive should know this.
- **Listener throws on post-events don't roll back.** Use cancelable `.<verb>ing` events for transaction-aborting side effects.
- **One `EventBus` per `UnitOfWork`.** UoW takes the bus to know where to flush. Apps with multiple buses (rare) would construct multiple UoWs.

## When to use which

| | `UnitOfWork.run(fn)` | `Database.transaction(fn)` |
|---|---|---|
| Single multi-statement write across multiple repositories | ✓ | works, but you thread `tx` |
| Need queue-until-commit lifecycle events | ✓ | — |
| Auto-route Repository calls through `tx` | ✓ | — |
| Lower-level: no event integration, manual `tx` threading | — | ✓ |
| Apps without `@strav/database` Repository | — | ✓ |

If you're using Repositories: prefer `UnitOfWork.run`. If you're hand-writing SQL: `Database.transaction` is fine.
