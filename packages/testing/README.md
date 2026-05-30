# @strav/testing

Small, focused testing utilities for Strav apps and the framework itself.

```ts
import {
  bootTestApp,
  isPostgresAvailable,
  MemStream,
  stubFetch,
} from '@strav/testing'

if (!await isPostgresAvailable()) {
  test.skip('integration: …', () => {})
} else {
  // real Postgres flow
}

const stdout = new MemStream()
const fetch = stubFetch(async (req) => Response.json({ ok: true }))
```

Canonical docs live in [`docs/testing/README.md`](../../docs/testing/README.md).

## What ships

| Surface | Notes |
|---|---|
| `bootTestApp({ config, schemas, migrations, providers })` | Replaces the ~50-line `beforeAll` boilerplate every e2e was rolling. Auto-supplies the standard four providers, applies schemas + migrations against `setupDb`, returns `{ app, setupDb, dispose }`. |
| `composeTestConfig(overrides)` | Merges logger + database defaults with per-test overrides. Used internally by `bootTestApp`; exported for tests that want the config tree without the orchestrator. |
| `TenantManagerProvider` | Standard 3-line wiring extracted from m5 / m6 / m7. |
| `MemStream` | In-memory `NodeJS.WritableStream` for asserting on stdout / stderr. Pairs with `ConsoleOutput`. |
| `stubFetch(handler)` | Typed `fetch` replacement. Confines the `as unknown as typeof fetch` cast to one place. |
| `isPostgresAvailable()` | Cached probe — returns `false` when env is missing or connection fails. |
| `createTestDatabase()` | Construct a fresh `PostgresDatabase` from `DB_HOST`/`DB_PORT`/etc. |
| `resetSchema(db)` | DROP + recreate `public` schema. |
| `connectedRoleBypassesRls(db)` | True for SUPERUSER / BYPASSRLS roles — tests use it to degrade RLS assertions. |
| `testDatabaseUrl()` | Returns the Postgres URL or `null` when env is missing. |

## Subpaths

- `@strav/testing/postgres` — narrow import for just the Postgres helpers.
- `@strav/testing/brain` — `stubBrainProvider({ embed, model? })`. Requires `@strav/brain` installed (peer-optional).

Deferred to follow-up slices: `stubPaymentDriver`, `stubSocialDriver` — extract when the inline forms in `tests/e2e/m{6,7}-*/` show overlap.
