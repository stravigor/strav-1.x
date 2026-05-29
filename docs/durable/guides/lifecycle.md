# The durable run lifecycle

What actually happens between `runner.start(name, input)` and `RunSnapshot.status === 'completed'`. Read this before writing your first step handler — knowing which transitions happen where shapes how you write code that's safe to retry.

## The pipeline

```
              ┌─────────────────────────────────────────────────────────────┐
              │                                                             │
   start ─→ pending ─→ running ─→ running ─→ ... ─→ completed               │
                         │           │                                      │
              (handler   │           │ (handler throws,                     │
               throws,   │           │  attempts < max)                     │
              attempts   │           ▼                                      │
              < max)     │  dispatchLater(advance)──┐                       │
                         │                          │                       │
                         ▼                          │                       │
                  dispatchLater(advance)            │                       │
                         │                          │                       │
                         ▼                          ▼                       │
                  (attempts >= max)                                         │
                         │                                                  │
                         ▼                                                  │
                  compensating ─→ failed                                    │
                                    ▲                                       │
              ──────────────────────┘                                       │
              (every completed-step's compensator ran)                      │
                                                                            │
   find() can be called at any time; status is the column above.            │
              ┘
```

## Phase by phase

### `start(name, input)` — pending → running

Inside one Postgres transaction:

1. INSERT a row into `strav_workflow_runs` with `status = 'pending'`, `current_step = 0`, `state = { results: {}, stepAttempts: {} }`.
2. `queue.dispatch(DurableAdvanceJob, { runId })` — appends to `strav_jobs` in the same transaction.

If the transaction commits, both the run row and the queue row are visible to the rest of the system. If it rolls back (DB error, the connection dies mid-INSERT), neither exists — no orphans, no half-started runs.

The first `advance` job runs immediately (no delay). It picks up the run with `status = 'pending'` and flips it to `'running'` as it processes the first step.

### `advance(runId)` — running → running

The hot loop. Per call, inside one transaction:

1. `SELECT … FOR UPDATE` the run row. This serializes concurrent advances for the same run id — a duplicate queue redelivery for the same run blocks until the in-flight advance commits.
2. If `status` is `completed` or `failed`, return without touching anything. Late deliveries of a run that already finished are no-ops.
3. Resolve the workflow + the step at `current_step`.
4. Look for a journal row with `(run_id, step.name)` AND `status = 'completed'`. If found, the step already succeeded — bump `current_step` and update `state.results[step.name]` from the journal row. Skip the handler.
5. Otherwise call the handler with `ctx = { input, results, runId, attempt }`. Three outcomes:
   - **Return** — INSERT a journal row with `status = 'completed'`, write the result into `state.results[step.name]`, drop the per-step retry counter from `state.stepAttempts`, bump `current_step`. If past the last step, mark `completed`. Otherwise, queue the next `DurableAdvanceJob` and stay `'running'`.
   - **Throw, retries left** — increment `state.stepAttempts[step.name]`, write the state, `queue.dispatchLater(backoff, DurableAdvanceJob)`. The run stays `'running'`.
   - **Throw, retries exhausted** — INSERT a journal row with `status = 'failed'`, write the error to the run's `error` column, mark status `'compensating'`, queue `DurableCompensateJob`.

The dispatch of the *next* `DurableAdvanceJob` after a successful step happens **outside** this transaction — see the next section for why.

### Why the next-step dispatch is outside the transaction

If a step's handler takes 30 seconds (external API call), holding the `SELECT FOR UPDATE` lock for the entire 30 seconds would block every other operation on that row — including a `find()` call from a UI poll. The runner releases the lock as soon as the journal write commits, then enqueues the next `advance` job in a separate `queue.dispatch` call.

The tradeoff: between commit and the next dispatch, the run is "queued but no job is queued for it." If the worker process crashes here, the run row says `'running'` with no jobs queued. The next worker restart needs to detect orphaned runs — V1 doesn't ship a recovery loop for this (apps can write a periodic `durable:resume-orphans` cron with a SELECT `WHERE status = 'running' AND updated_at < now() - interval '5 minutes'` query that re-dispatches `DurableAdvanceJob`).

The same can happen if the *current* `advance` transaction commits but the next dispatch fails (transient DB error in the queue insert). A future slice lands the recovery loop; today the workaround is the orphan cron.

### `compensate(runId)` — compensating → failed

Inside one transaction:

1. `SELECT FOR UPDATE` the run row. Return if `status !== 'compensating'`.
2. Resolve the workflow.
3. SELECT the journal ordered by `completed_at ASC`.
4. Walk completed-step rows in reverse declaration order (using `workflow.steps`'s order, not the journal order — completed sets are equivalent but the workflow steps tell us the canonical iteration order and let us skip failed-step rows).
5. For each step with a `compensate` callback, await it. On throw, log the error and continue — the rest of the walk still runs.
6. UPDATE `status = 'failed'`.

If `compensate` itself throws (out of the runner's per-compensator try/catch — e.g. a DB connection drop), the queue's `Worker` sees the throw and routes the job to the dead-letter via the standard pipeline. The run row stays `'compensating'`; a later operator inspects the dead-letter row, reruns or manually fixes the failed state.

## What's journaled when

| Event | Row in `strav_workflow_journal` |
|---|---|
| Step returns | `status = 'completed'`, `result = <return value>`, `attempts = <attempt count>` |
| Step throws, retries left | none (retry counter lives on the run row's `state.stepAttempts`) |
| Step throws, retries exhausted | `status = 'failed'`, `error = <message>`, `attempts = <final attempt>` |
| Compensator runs | none — compensation is fire-and-forget within the runner |

The journal is the **idempotency layer** for advance jobs. A worker that finishes a step, journals success, then crashes before committing the run-row cursor update would re-deliver the same `advance` and re-run the step — except the journal lookup catches it and skips. (V1 keeps the journal write + cursor update in the same transaction, so this race doesn't actually happen — but the journal-first model still matters if a future slice changes the transaction boundary.)

The journal is **NOT** an audit trail of attempts. In-flight retry counters live on the run row's `state.stepAttempts` field; only the terminal step outcome (success or final failure) lands in the journal. A step that retried twice before succeeding ends up with one journal row showing `attempts = 3`.

## When the runner cancels its own transaction

The advance transaction rolls back when:

- The step handler throws AND we hit terminal failure. (The error is logged via the journal INSERT + run update; the rollback only happens if those writes themselves fail.)
- A DB error occurs during a write.
- The `SELECT FOR UPDATE` couldn't be acquired (unlikely — Postgres queues row-lock waiters).

On a rollback, the queue's Worker sees the throw, retries the `DurableAdvanceJob` per its own retry config — which is `maxAttempts = 1`, so the job goes to the dead-letter on the first throw. From there an operator manually retries or fixes the run state.

## Failure modes at a glance

| Failure | Final state |
|---|---|
| Every step returns | `completed`, `result = <all step results>` |
| One step exhausts retries | `failed`, error column = last error |
| Step throws + compensator runs cleanly | `failed`, compensation completed |
| Step throws + compensator throws | `failed`, compensator error logged; run still flips to `failed` |
| Engine fails inside `advance` | Queue dead-letter; run stays in `running` / `compensating` |
| Engine fails inside `compensate` | Queue dead-letter; run stays in `compensating` |
| Process crash between journal commit and next dispatch | Run stays in `running` with no queued jobs (orphan; recovery loop deferred to V2) |

## A note on idempotency

This is the same assumption every durable runtime makes: **step handlers and compensators may run more than once**. Write them so that running twice is harmless — Stripe idempotency keys for charges, INSERT … ON CONFLICT DO NOTHING for row creation, no-op DELETE on already-deleted rows.

V1's journal protection means a step that *committed* won't be re-run by the runner. But a step that started, made an external API call, then crashed before the journal write *will* be re-run on the next delivery — and the API call will run twice. The runner can't protect external side effects; only your handler can.
