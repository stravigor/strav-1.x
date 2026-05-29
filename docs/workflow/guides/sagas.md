# Sagas: workflow compensation

The "saga" pattern handles failures in long-running, multi-step business processes by **rolling back successful steps in reverse order**. `@strav/workflow` implements this as the `compensate` option on each step (and per-entry on `parallel` blocks).

## The shape

```ts
const orderWorkflow = defineWorkflow<{ orderId: string }>('order:place')
  .step('reserve', async (ctx) => reserveInventory(ctx.input.orderId), {
    compensate: async (ctx) => releaseInventory(ctx.results.reserve.reservationId),
  })
  .step('charge', async (ctx) => chargePayment(ctx.input.orderId), {
    compensate: async (ctx) => refundPayment(ctx.results.charge.chargeId),
  })
  .step('ship', async (ctx) => scheduleShipping(ctx.input.orderId))
```

If `ship` throws:

1. `WorkflowError` is constructed with `context.step = 'ship'` + `cause = <ship's throw>`.
2. The rollback pass runs **in reverse declaration order** over every *completed* step:
   - `ship` has no compensator → skipped.
   - `charge.compensate` fires → `refundPayment(ctx.results.charge.chargeId)`.
   - `reserve.compensate` fires → `releaseInventory(ctx.results.reserve.reservationId)`.
3. `WorkflowError` is rethrown.

If `reserve` throws (the first step), there's nothing to compensate — the error is rethrown immediately.

## What runs compensation

| Step kind | Compensation behavior |
|---|---|
| `.step()` | Per-step `options.compensate` runs on rollback |
| `.parallel()` | Each entry's `compensate` runs on rollback. All entries that **completed before** the failure are compensated; if one parallel entry throws, the others that finished within the same `Promise.all` still get compensated |
| `.route()` | No compensation in V1. If you need rollback for routed work, put the cleanup inside a regular `.step()` after the route |
| `.loop()` | No compensation in V1. Same workaround — wrap or follow with a `.step()` that owns the cleanup |

This isn't a forever-restriction. It's a "ship simple first" choice — the surface for route/loop compensation needs more design (per-branch? per-iteration?). It lands when a real app needs it.

## Ordering: declaration vs reverse

Compensators run in **reverse declaration order**, mirroring how database transactions roll back stacked savepoints. The mental model: each step assumes prior steps have committed; compensation peels them off in LIFO order.

```ts
wf
  .step('a', …, { compensate: compA })
  .step('b', …, { compensate: compB })
  .step('c', …, { compensate: compC })
  .step('d', …)   // fails

// Rollback order: compC, compB, compA
```

Parallel-entry compensators run in their declared array order during the reverse pass:

```ts
wf
  .parallel('fanout', [
    { name: 'a', handler: …, compensate: compA },  // declared first
    { name: 'b', handler: …, compensate: compB },  // declared second
  ])
  .step('after', …)  // fails

// Rollback order: compA, compB (declaration order within the parallel block,
// then the reverse pass continues to earlier steps)
```

## When compensators themselves fail

`WorkflowError` is the "everything cleaned up; the step itself failed" signal. **`CompensationError`** is the "we tried to clean up and couldn't" signal — a different operational problem. Apps probably want to handle them differently:

- `WorkflowError` → retry, log, alert on systemic failures.
- `CompensationError` → page an operator. Something is in an inconsistent state.

```ts
try {
  await orderWorkflow.run({ orderId })
} catch (err) {
  if (err instanceof CompensationError) {
    // Critical: charge may have succeeded but refund failed, OR inventory
    // is still reserved but ship couldn't be scheduled. Manual triage.
    const failures = err.context.failures as Array<{ step: string; message: string }>
    await pagerDuty.alert({
      orderId,
      original: (err.context.originalError as { message: string }).message,
      cleanup: failures,
    })
  } else if (err instanceof WorkflowError) {
    // Routine: clean-failure path. The system is in a consistent state;
    // it's safe to retry or surface to the user.
    return ctx.response.serviceUnavailable({ retryAfter: 30 })
  }
  throw err
}
```

`CompensationError` continues attempting **all** compensators even when earlier ones throw — it doesn't short-circuit on the first failure. That maximizes cleanup at the cost of running more code under fault. Apps that need fail-fast on compensator error should put the critical compensator first (it runs last) and wrap its logic to abort the rest, or build their own compensation orchestration outside the workflow.

## Idempotency: a load-bearing assumption

The rollback runs in-process, after the original throw. If the process dies between "step succeeds" and "compensator runs", **the compensator never fires**. Your business logic has to assume:

- Steps may run zero or one times. Stripe's idempotency keys, INSERT-with-`ON CONFLICT DO NOTHING`, etc.
- Compensators may run zero, one, or two times (if a transient failure means you retry the whole workflow and the previous run died mid-compensation). Refunds on already-refunded charges should be no-ops. DELETEs on already-deleted rows should be no-ops.

If your steps and compensators aren't idempotent, you don't have a saga — you have a worse race condition. This is the **same** assumption every saga implementation makes, including the one in `@strav/durable` when it lands. Durable workflows persist the step state so the rollback resumes across crashes, but they can't make a non-idempotent compensator safe.

## When to skip the saga

Use the saga when the steps span **independent systems** — charge a card, reserve inventory in a different DB, schedule a shipment via an external API. The rollback is the only way to keep them consistent.

Don't use the saga when all the steps live in **one transaction**. If `reserve`, `charge`, and `ship` are all rows in the same Postgres, wrap them in `UnitOfWork.run(async () => { … })` and let Postgres roll back. The saga is the consolation prize for not having a distributed transaction.
