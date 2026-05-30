# @strav/testing

Small, focused testing utilities. The five-minute helpers that get re-implemented inline in every test until someone moves them to a shared spot — this is that spot.

```ts
import {
  createTestDatabase,
  isPostgresAvailable,
  MemStream,
  resetSchema,
  stubFetch,
} from '@strav/testing'
```

## What ships

| Surface | Where |
|---|---|
| `bootTestApp({ config, schemas, migrations, providers })` orchestrator | `@strav/testing` |
| `composeTestConfig(overrides)` + `TenantManagerProvider` building blocks | `@strav/testing` |
| In-memory `WritableStream` + typed `fetch` stub | `@strav/testing` |
| Postgres availability probe + schema reset + role probe | `@strav/testing` (also at `@strav/testing/postgres`) |
| `stubBrainProvider({ embed, model? })` | `@strav/testing/brain` (peer-optional `@strav/brain`) |
| `stubPaymentDriver` / `stubSocialDriver` | **deferred** — inline forms in `tests/e2e/m{6,7}-*/` are tightly coupled to test logic; will fold them in when a second caller appears with overlapping requirements. |

## Install

```bash
bun add -d @strav/testing
```

`@strav/testing` is a `devDependency` — it's never imported from production code paths. It depends on `@strav/database` + `@strav/kernel`. `@strav/brain` is a `peerDependency` flagged optional — apps that use `@strav/testing/brain` must have brain installed; apps that don't, don't.

## `bootTestApp`

The orchestrator that replaces the ~50-line `beforeAll` boilerplate every integration / e2e suite was rolling. Auto-supplies the standard four providers (`Config` → `Logger` → `Database` → `TenantManager`), applies schemas + migrations against `setupDb` outside the app's connection, and returns `{ app, setupDb, dispose }`.

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  bootTestApp,
  type BootTestAppResult,
  isPostgresAvailable,
} from '@strav/testing'
import { stubBrainProvider } from '@strav/testing/brain'
import {
  applyRagVectorMigration,
  RagProvider,
  ragVectorSchema,
} from '@strav/rag'

const PG = await isPostgresAvailable()

describe.skipIf(!PG)('rag e2e', () => {
  let booted: BootTestAppResult

  beforeAll(async () => {
    booted = await bootTestApp({
      config: {
        rag: {
          default: 'pg',
          embedding: { provider: 'stub', model: 'stub', dimension: 4 },
          chunking: { strategy: 'recursive', chunkSize: 256, overlap: 0 },
          stores: { pg: { driver: 'pgvector' } },
        },
      },
      schemas: [tenantSchema, articleSchema, ragVectorSchema],
      migrations: [
        (db, registry) => applyRagVectorMigration(db, { dimension: 4, registry }),
      ],
      providers: [
        stubBrainProvider({ embed: bagOfWordsEmbedding }),
        new RagProvider(),
      ],
    })
  })

  afterAll(() => booted.dispose())

  test('…', async () => {
    const rag = booted.app.resolve(RagManager)
    // ...
  })
})
```

Order of operations:

1. `createTestDatabase()` → admin connection for setup.
2. `resetSchema(setupDb)` → DROP + CREATE `public`.
3. Apply each schema's `emitCreateTable(schema, { registry }).sql`.
4. Run each migration with `(setupDb, registry)`.
5. Compose config via `composeTestConfig(config)` (auto-supplies logger + `database.url`).
6. `new Application().useProviders([Config, Logger, Database, TenantManager, ...providers])`.
7. Bind `SchemaRegistry` as a singleton.
8. `await app.start({ signalHandlers: false })`.
9. `dispose()` shuts the app down and closes `setupDb`.

What's auto-supplied:

- `ConfigProvider` with `logger: { level: 'silent', channels: { main: { driver: 'stderr' } } }` and `database: { url }` from `DB_*` env. Per-test sub-trees (`rag`, `payment`, `social`, `encryption`, …) merge into the same tree.
- `LoggerProvider`, `DatabaseProvider`, and `TenantManagerProvider` — the three-provider trio every e2e was redeclaring.
- `SchemaRegistry` bound as a singleton with the supplied `schemas`.

What stays per-test:

- The package-specific providers (`RagProvider`, `PaymentProvider`, `SocialProvider`, …) and any per-test domain providers (HTTP routes, repository bindings).
- Post-boot manager hand-wiring (`manager.useDriver(...)`) for stubs that can't go through `ConfigRepository`. See `docs/contributing/building-an-adapter.md` §"Vendor SDK ≠ config".
- Custom test fixtures (seeding tenants, building HTTP servers, …).

Opt out of the auto-supplied providers with `skipDefaultProviders: true` — useful when a test needs a custom `LoggerProvider` or no `DatabaseProvider`. You own the entire `providers` list in that case.

## `composeTestConfig` + `TenantManagerProvider`

The building blocks `bootTestApp` uses internally. Exported for tests that want one without the other — e.g., compose the test config tree manually then pass to an existing `Application` setup.

```ts
import { composeTestConfig, TenantManagerProvider } from '@strav/testing'

const app = new Application()
app.useProviders([
  new ConfigProvider(composeTestConfig({ rag: { ... } })),
  new LoggerProvider(),
  new DatabaseProvider(),
  new TenantManagerProvider(),
  // ...
])
```

## `stubBrainProvider`

For tests that need a deterministic embedder without dialing an actual brain backend. Lives at `@strav/testing/brain` so apps that don't use `@strav/brain` don't pay for the install.

```ts
import { stubBrainProvider } from '@strav/testing/brain'

const provider = stubBrainProvider({
  embed: (text) => bagOfWordsEmbedding(text), // returns number[]
  model: 'my-stub-model', // optional, default 'stub'
})

app.useProviders([
  new ConfigProvider({ ... }),
  new LoggerProvider(),
  new DatabaseProvider(),
  provider,            // ← stub registered, name: 'brain'
  new RagProvider(),   // ← resolves the stub
])
```

V1 only stubs `embed`. Other `BrainManager` methods (`chat`, `stream`, `runWithTools`, …) throw when called — extend the stub when a use case appears.

## `MemStream`

Pairs with `@strav/kernel`'s `ConsoleOutput` and `@strav/cli`'s command flows — both accept a `NodeJS.WritableStream` pair, and `MemStream` is the smallest possible double.

```ts
import { ConsoleOutput } from '@strav/kernel'
import { MemStream } from '@strav/testing'

const stdout = new MemStream()
const out = new ConsoleOutput({ stdout: stdout.asWritable(), useColor: false })
out.line('hello')
expect(stdout.text()).toBe('hello\n')
```

`asWritable()` exists so callers don't need `as unknown as NodeJS.WritableStream` at every test site — the cast is confined to the package.

Other surface: `chunks: string[]` (raw write log), `clear()` (drop everything written so far — useful between assertions in a single test).

## `stubFetch(handler)`

For drivers that take a `fetch` injection point (OAuth clients, pure-fetch brain providers), tests typically end up with `as unknown as typeof fetch` boilerplate around an inline async function. `stubFetch` confines that cast to one place and normalizes the input to a `Request` so the handler doesn't have to branch on shape.

```ts
import { stubFetch } from '@strav/testing'

const captured: Request[] = []
const driver = new LineSocialDriver({
  config: { ... },
  fetch: stubFetch(async (req) => {
    captured.push(req)
    if (req.url.includes('/token')) {
      return Response.json({ access_token: 'AT_1', expires_in: 3600 })
    }
    return new Response('not found', { status: 404 })
  }),
})
```

The handler receives a `Request` whether the caller invoked `fetch` with a URL + init, a URL string, or an existing Request. Normalize once, branch on `req.method` / `req.url` / `await req.text()` / `await req.json()` inside the handler.

## Postgres helpers

```ts
import {
  connectedRoleBypassesRls,
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '@strav/testing'

if (!await isPostgresAvailable()) {
  test.skip('integration: …', () => {})
} else {
  const db = createTestDatabase()
  await resetSchema(db)
  // run migrations + tests
  await db.close()
}
```

`isPostgresAvailable()` reads `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE`, returns `false` when any are missing or the connection probe fails, and caches the result for the process lifetime. So `bun test` is a no-op for integration tests in environments without local Postgres — no skip-noise, no failing connections.

`resetSchema(db)` drops + recreates the `public` schema. Bulletproof isolation between integration test runs at the cost of a sledgehammer — the integration test database owns its state and shouldn't be pointed at anything precious.

`connectedRoleBypassesRls(db)` returns `true` when the connected role is SUPERUSER or has BYPASSRLS. Such roles ignore `ENABLE ROW LEVEL SECURITY` even with `FORCE` set — tests use this to self-skip the RLS-isolation check while still exercising the rest of the tenancy path. Local-dev databases often share one superuser for convenience; this helper degrades gracefully there.

## Subpath: `@strav/testing/postgres`

The Postgres helpers are also re-exported under `@strav/testing/postgres` for tests that want to be explicit about what they depend on:

```ts
import { isPostgresAvailable, resetSchema } from '@strav/testing/postgres'
```

Same symbols — same implementations. The subpath is sugar.

## Backward compatibility

`tests/support/postgres_test_db.ts` (the workspace-level fixture) now re-exports from `@strav/testing`. Existing imports of that path keep working; new code should import from `@strav/testing` directly.

## When NOT to reach for this

- **Stubbing out a vendor SDK in tests.** Use the matching driver's `client?:` constructor option (see `docs/contributing/building-an-adapter.md` §"Vendor SDK ≠ config"). `MemStream` and `stubFetch` are for output / network-edge stubbing.
- **Asserting on framework internals.** Most framework packages ship their own test doubles (`InMemoryDatabase`, `FakeQueue`, etc.) inside `packages/<name>/tests/`. Use those instead — they're tuned to the package's contract.
- **`bootTestApp` doesn't fit your test.** Reach for the building blocks directly (`composeTestConfig`, `TenantManagerProvider`) or skip the helpers entirely. Tests that boot a Bun HTTP server, hand-wire post-boot drivers via `useDriver(...)`, or do non-standard setup work just fine without `bootTestApp` — they were doing it before and still can.
