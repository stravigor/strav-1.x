# Implementing a Strav package

A handover doc for whoever picks up a remaining `@strav/*` package. This is the practical "how" — file layout, the provider pattern, container conventions, console commands, tests, docs — distilled from what's actually shipped (kernel, http, database, auth, queue, signal, view, cli).

If you're an **app developer** looking at how to use Strav, you want `docs/<package>/README.md` instead.

## What's left

As of 2026-05-28, the workspace ships eight packages. The remaining 1.0 packages are split across two milestones:

### M4 still to do

| Package | Status | Lift |
|---|---|---|
| `@strav/auth` | M2 base shipped; TOTP + magic links + email verification deferred | Small extensions |
| `@strav/signal` | M3 mail layer shipped; **notifications + broadcast + SSE + inbound parsers** deferred | Medium |
| `@strav/view` | M3 engine + islands shipped; **pages auto-router** still missing | Small |
| `@strav/cli` | M4 slices 1-6 shipped; **plugin / cache / config / tenant commands** deferred (slice 7 partial) | Small |
| `@strav/testing` | v1 shipped (2026-05-30) — `MemStream`, `stubFetch`, Postgres helpers. `bootTestApp` + stub-driver factories deferred to a follow-up slice. | Small remainder |

### M5 — entire AI + specialty + spring

| Package | Dep chain | Notes |
|---|---|---|
| `@strav/workflow` | `kernel` | Sequential / parallel / route / loop + saga compensation. Pure functions, no I/O. |
| `@strav/machine` | `kernel`, `database` | `defineMachine` + transitions + guards + `stateful()` Repository mixin. |
| `@strav/durable` | `kernel`, `queue`, `machine`, `workflow` | Crash-resumable workflows. The capstone — depends on the other three. |
| `@strav/brain` | `kernel`, `workflow` | Anthropic / OpenAI / Gemini / DeepSeek providers + agents + threads. Folds in `@strav/brain/mcp`. |
| `@strav/rag` | `kernel`, `brain`, `database`, `cli` | pgvector + in-memory drivers + chunking + `retrievable()` mixin. |
| `@strav/social` | `kernel`, `http`, `database` | OAuth client drivers (Google, GitHub, Facebook, Microsoft, Apple). |
| `@strav/stripe` | `kernel`, `database`, `http` | Stripe SDK wrapper + subscriptions + Connect + webhooks + `billable()` mixin. |
| `@strav/omise` | `kernel`, `database`, `http` | Omise charges + customers + webhooks (SEA parity). |
| `@strav/line` | `kernel`, `signal` | LINE Messaging API (Flex Messages, Rich Menu, LIFF). |
| `@strav/flag` | `kernel`, `database`, `http`, `cli` | Feature flags with DB persistence + HTTP endpoints + console commands. |
| `@strav/search` | `kernel`, `database`, `cli` | FTS abstraction (Meilisearch / Typesense / pg) + `searchable()` mixin. |
| `@strav/captcha` | `kernel`, `http` | Honeypot + proof-of-work captcha + SVG renderer. Vue island. |
| `@strav/devtools` | `kernel`, `http`, `database`, `cli` | Request inspector + dev error page + performance probes + REPL. |
| `@strav/faker` | `kernel` | Deterministic fake data (seedable RNG). |
| `@strav/spring` | independent | Project scaffolder (`bunx @strav/spring my-app`). Versions outside the lockstep. |

### Deferred until after 1.0

| Package | Status |
|---|---|
| `@strav/audit` | Designed in 0.x `specs/framework-gap.md`. |
| `@strav/transit` | CSV / JSONL ETL pipelines. |
| `@strav/signal/webhook` | Outbound event-subscriber webhooks. |

Don't ship these in 1.0.

## Anatomy of a package

Every `@strav/*` package belongs to one of two shapes. Pick the right one before writing the first file — switching later is invasive.

### Subsystem vs manager + drivers

| Shape | Criterion | Examples |
|---|---|---|
| **Subsystem** | Single coherent service. No swappable backend. The whole package is the implementation. | `kernel`, `http`, `auth`, `database`, `signal`, `view`, `cli`, `queue`, `workflow`, `machine`, `durable` |
| **Manager + drivers** | A `XxxManager` facade with a public driver interface and ≥1 vendor backends behind it. Apps pick a backend via config; the manager dispatches. | `brain`, `payment`, `social`, `rag` |

If your package has a `<name>_manager.ts` + a `<name>_driver.ts` interface + vendor-specific config keys, it's manager+drivers. Otherwise it's a subsystem.

### Subsystem layout

```
packages/<name>/
├── src/
│   ├── index.ts                     # public barrel — every export goes through here
│   ├── <name>_provider.ts           # ServiceProvider (one per package, root level)
│   ├── console/                     # if it ships commands
│   │   ├── index.ts
│   │   ├── <name>_console_provider.ts
│   │   └── <command>.ts             # one file per command
│   ├── <subsystem>/                 # one folder per major concern
│   │   ├── index.ts
│   │   └── *.ts
│   └── *.ts                         # top-level files for shared shapes
├── tests/
│   ├── <unit>.test.ts               # unit tests, mirror src/ structure
│   ├── console/                     # if shipping commands
│   └── integration/                 # tests that need real Postgres / network
├── package.json
├── tsconfig.json                    # extends ../../tsconfig.base.json
└── README.md                        # short — the canonical docs live in docs/<name>/
```

When in doubt, copy `@strav/auth` (smallest clean subsystem) or `@strav/database` (most complex shipped).

### Manager + drivers layout

```
packages/<name>/src/
├── index.ts                         # public barrel
├── <name>_provider.ts               # ServiceProvider
├── <name>_manager.ts                # the facade apps inject
├── <name>_driver.ts                 # driver interface — what every backend implements
├── <name>_config.ts                 # ProviderConfig shape + default exports
├── <name>_error.ts                  # typed error hierarchy
├── types.ts  |  dto/                # shared shapes (use `dto/` directory when >3 DTOs)
├── drivers/                         # ALL driver implementations live here
│   ├── unsupported.ts               # shared "throw unsupported" helper (when applicable)
│   ├── mock_<name>_driver.ts        # in-process test double (when shipped)
│   └── <vendor>/                    # one subdirectory per vendor backend
│       ├── index.ts                 # barrel — what `./<vendor>` subpath export points at
│       ├── <vendor>_<name>_driver.ts
│       ├── <vendor>_config.ts       # vendor-specific config shape
│       ├── <vendor>_provider.ts     # vendor ServiceProvider (when needed)
│       ├── <vendor>_helpers.ts      # vendor-internal utilities
│       ├── <vendor>_message_builder.ts   # request builders, when applicable
│       ├── <vendor>_response_mapper.ts   # response mappers, when applicable
│       ├── <vendor>_webhook.ts      # webhook normalization (when vendor has webhooks)
│       └── ...
├── <feature>/                       # persistence / webhook / mcp / ... — name carries the domain
│   ├── <entity>_schema.ts           # single-table feature: file at root of the feature folder
│   ├── schemas/                     # OR a multi-table directory:
│   │   └── <entity>_schema.ts       #   one file per entity (file-name = symbol convention preserved)
│   └── <entity>_repository.ts
└── console/                         # if commands shipped
```

Rules:

- **Always-subdir for vendor drivers.** Even a one-file driver (rag's `memory`) lives at `drivers/memory/memory_driver.ts`. The rule is dead simple: every backend is a directory. No mixing flat vendor files with subdir vendors in the same package.
- **`drivers/` is the driver shelf.** Vendor subdirs + shared driver utilities (mock, unsupported helper) sit here. Nothing else does. If a file isn't a driver or a driver utility, it doesn't belong under `drivers/`.
- **Each vendor subdir is self-contained.** Driver class + config + helpers + builders + mappers + webhooks for that vendor live together. No vendor-specific code outside its subdir.
- **One barrel per vendor subdir.** `drivers/<vendor>/index.ts` re-exports the vendor's public symbols. When the package's `package.json` exports field surfaces `./<vendor>` as a subpath, it points at this barrel.
- **Persistence folders keep their domain name.** `payment/ledger/`, `social/ledger/`, `social/tenanted/`, `brain/persistence/` — the name carries meaning. The rule is "one folder per persistence concern," not a forced rename to `persistence/`.
- **Schemas live under a feature folder, never at `src/` root.** Single-table feature: `<feature>/<entity>_schema.ts` at the folder root. Multi-table feature: `<feature>/schemas/<entity>_schema.ts`. File name always carries the entity (`payment_invoice_schema.ts`, not `schema.ts`) — the "one public symbol per file, file name = primary export" rule still applies. See `docs/code-quality.md` §2.3.
- **`<name>_provider.ts` (the ServiceProvider) stays at `src/` root.** It's the package's entry-point wiring, not a driver.

Canonical example: copy `@strav/payment` — vendor subdirs (`drivers/stripe/`, `drivers/omise/`), shared helpers at `drivers/` root, schemas under `ledger/schemas/`, subpath exports for tree-shaking. `@strav/brain` is the largest specimen (7 vendor subdirs); `@strav/rag` is the smallest (2 vendors, no subpath exports).

Workspace `packages/*` glob auto-discovers the new directory. Just `bun install` after creating the `package.json`.

## Naming + file-org conventions (from CLAUDE.md)

These don't change between packages — match them exactly or PR review pushes back:

- **Classes**: PascalCase. **methods**: camelCase. **files / folders**: snake_case. **DB tables**: snake_case. **URLs**: kebab-case. **events**: dot.case.
- Every public symbol exported from `src/index.ts`.
- **One public symbol per file.** File name = primary export, snake_cased. (`HttpKernel` lives in `http_kernel.ts`. `UserRepository` lives in `user_repository.ts`.)
- No static singletons. Everything goes through the container.
- No `throw new Error('string')` — typed `StravError` subclasses only.
- TypeScript strict + `noUncheckedIndexedAccess` + `noImplicitOverride`.

## The ServiceProvider pattern

Every package with runtime initialization ships one `ServiceProvider`. Real example, lightly trimmed (`packages/http/src/http_provider.ts`):

```ts
import { type Application, ConfigRepository, Logger, ServiceProvider } from '@strav/kernel'
import { HttpKernel } from './http_kernel.ts'
import { Router } from './router/router.ts'

export interface HttpConfigShape {
  middleware?: readonly string[]
  appDomain?: string
  trustProxy?: boolean
  // …
}

export class HttpProvider extends ServiceProvider {
  override readonly name = 'http'
  override readonly dependencies = ['config', 'logger']

  override register(app: Application): void {
    app.singleton(Router, () => new Router())
    app.singleton(HttpKernel, (c) => new HttpKernel({
      app,
      router: c.resolve(Router),
      // …
    }))
  }

  override async boot(app: Application): Promise<void> {
    const router = app.resolve(Router)
    router.compile()
  }

  override async shutdown(app: Application): Promise<void> {
    // optional — close pools, flush buffers
  }
}
```

The contract:

1. **`name`** is the string apps reference via `static providers = ['http']` on a command. Lowercase, kebab if multi-word (`'database.admin'`).
2. **`dependencies`** are other provider `name`s. The kernel topo-sorts before booting. List every provider whose bindings you'll resolve in `register()` or `boot()`.
3. **`register()`** binds factories into the container. **Sync** — `boot()` is for async work. Don't `app.resolve()` here; other providers may not have registered yet.
4. **`boot()`** is the async init pass. Connect pools, eagerly compile, validate config. Runs after every provider has registered.
5. **`shutdown()`** is reverse-topological. Close idempotently; best-effort, never throw past the kernel boundary.

When in doubt, mirror `DatabaseProvider` (the most complex shipped) or `MailProvider` (the most config-driven).

## Container bindings — when to use what

The container exposes three lifetimes:

| Method | Lifetime | Use it for |
|---|---|---|
| `app.singleton(Key, factory)` | Created once, cached forever | Connection pools, kernels, registries — anything with state that should be shared. |
| `app.scoped(Key, factory)` | Per-scope, cached within that scope | Request-scoped values (`HttpRequest`, `HttpResponse`). Created inside `app.scope(fn)` blocks. |
| `app.register(Key, factory)` | Fresh instance every resolution | The exception, not the rule. Avoid unless you genuinely need it. |

You can register by:

- **Class constructor** (`app.singleton(Worker, () => new Worker(...))`) — most common.
- **String key** (`app.singleton('database', (c) => c.resolve(PostgresDatabase))`) — for cross-package aliases.

**Repository bindings need an explicit pass-through constructor.** TS only emits `design:paramtypes` metadata on classes with at least one decorator AND an own constructor. See `packages/auth/src/session/session_repository.ts` for the pattern. Don't ask the linter to "remove the useless constructor" — it's load-bearing.

**Repository takes `PostgresDatabase`, not `Database`.** Bun's container needs a runtime class for `@inject()`; interfaces don't survive to runtime. Apps that swap drivers extend `PostgresDatabase` or bind their class under the same key.

## Config integration

Two patterns shipped:

### "Config is required" (MailProvider)

```ts
const config = c.resolve(ConfigRepository).get('mail')
if (!config) throw new ConfigError('MailProvider: `config.mail` is missing.')
```

Use this when there's no sensible default — encryption keys, mail credentials, DB URL.

### "Config is optional with defaults" (ViewProvider)

```ts
const config = c.resolve(ConfigRepository).get('view') ?? {}
return new ViewEngine({ config })
```

Use this when convention (`resources/views/`) can carry the day. Document the defaults in the provider's class doc.

Always type the config shape: `export interface XConfigShape { ... }` on the provider file. Apps put a `config/<name>.ts` file in their project that exports that shape.

## Schemas + migrations (for DB-touching packages)

If your package owns a Postgres table, ship the schema as part of the package and let apps migrate it through the standard migration runner.

```ts
// packages/queue/src/job_schema.ts
import { Archetype, defineSchema } from '@strav/database'

export const jobSchema = defineSchema('strav_jobs', Archetype.Entity, (t) => {
  t.id()
  t.string('queue').max(64).default('default')
  // …
})
```

Conventions:

- **Table name is prefixed `strav_`** — `strav_jobs`, `strav_failed_jobs`, `strav_sessions`, `strav_scheduler_runs`. Avoids collision with app tables.
- **Export the `Schema` from the package barrel** so apps can `import { jobSchema } from '@strav/queue'` and pass it to `SchemaRegistry.registerAll([jobSchema, ...])`.
- **Don't ship migration files.** Apps generate their own via `bun strav migrate:generate -m "add queue tables"` once they've registered the schema. The schema + the live DB are the source of truth; migrations are app-owned artifacts.
- If the package needs **DB-side functions / triggers / RLS policies** (e.g., the tenancy slice's `emitTenantIdFunction`), export an emit-function from the package and let apps include its SQL in their migration.

## Console commands

The pattern is now well-trodden (see `packages/queue/src/console/`, `packages/database/src/console/`, etc.).

```ts
// packages/queue/src/console/queue_work.ts
import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { Worker } from '../worker.ts'

export class QueueWork extends Command {
  static signature = 'queue:work {--queue=default} {--max=}'
  static description = 'Run a queue worker until interrupted.'
  // static providers = ['config', 'logger', 'database']  // omit to boot everything

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const worker = this.app.resolve(Worker)
    // …
    return ExitCode.Success
  }
}
```

And a `ConsoleProvider` subclass to list them:

```ts
// packages/queue/src/console/queue_console_provider.ts
import { ConsoleProvider } from '@strav/cli'

export class QueueConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.queue'
  override readonly commands = [QueueWork, QueueRetry, /* … */] as const
}
```

Apps add `new QueueConsoleProvider()` to their `bootstrap/providers.ts` and `runCli` collects every command automatically.

Notes that bite:

- **Signature DSL**: `{name}` required, `{name?}` optional, `{--flag}` boolean, `{--flag=default}` string. Required positionals must come before optionals.
- **`static providers`**: omit for full-boot, `[]` for no-boot (writes-to-disk commands like `make:*`), `['config', 'database']` for a subset. Transitive `dependencies` auto-include.
- **`this.app`** is the booted `Application` (assigned by `handle()` before `execute()`). Use it for ad-hoc resolution.
- **`UsageError`** thrown inside `execute()` is caught by the base class and maps to exit code 2. Other exceptions bubble to the kernel's generic exit-1.
- **Long-running commands** (queue:work, scheduler:work, serve) wire SIGINT/SIGTERM to an `AbortController` and pass the signal to the run loop.

## Testing

Three layers, all `bun:test`:

### Unit tests — fast, no I/O

Mirror `src/` structure. Use lightweight test doubles (`InMemoryDatabase` in `packages/database/tests/`, `FakeQueue` / `FakeTenantManager` in `packages/queue/tests/scheduler.test.ts`). Tests run on every `bun test`.

### Integration tests — real Postgres, self-skip when absent

```ts
import { isPostgresAvailable } from '../helpers/postgres.ts'

if (!await isPostgresAvailable()) {
  test.skip('integration: …', () => {})
}
```

Live in `packages/<name>/tests/integration/` or the top-level `tests/integration/`. Skip when `process.env.DB_URL` is unset or the connection fails — keeps `bun test` green on a fresh checkout. Bring up Postgres via `docker-compose up -d && cp .env.test.example .env.test && source .env.test` to run them.

### e2e — multiple packages composed

Per-milestone smoke tests at `tests/e2e/<milestone>/`. One `Bun.serve` + real DB + a request flow that crosses package boundaries. Self-skip without Postgres, same as integration.

### Patterns worth keeping

- **MemStream + ConsoleOutput** for asserting on stdout/stderr (see `packages/cli/tests/command.test.ts`).
- **tmp-dir + `process.chdir`** for tests that exercise CWD-relative paths (see `packages/cli/tests/make_commands.test.ts`).
- **Test for the contract, not the implementation.** When a method is private, test it through its public caller.
- **Test doubles, not mocks.** A class that implements the same interface as `Database` is better than `jest.mock`.

## Docs

The doc-with-code rule (CLAUDE.md): every implementation change ships with the `docs/` update **in the same commit**.

Per-package layout:

```
docs/<name>/
├── README.md           # what it does, install, minimal example
├── api.md              # every public export — signature, semantics, example
├── guides/             # focused recipes (mail-from-zero, scheduler-onboarding, …)
└── reference/          # internals worth documenting (wire formats, etc.)
```

Tone:

- **README.md** answers "what's this for, how do I install, what does a 10-line app look like?"
- **api.md** answers "I'm about to call `X` — what does it accept, what does it return, what throws?" One section per export.
- **guides/** answers "how do I do <task>?" Single recipe per file, copy-paste runnable.
- **reference/** answers "why does this work the way it does?" SQL wire formats, protocol details, decision context.

When a feature lands across multiple packages (e.g., the migrate commands wire `@strav/cli` + `@strav/database`), put the guide in the package that owns the user surface — `docs/database/guides/migrations.md`, not `docs/cli/guides/migrating-the-database.md`.

## Publishing checklist

When a package is ready for the next alpha bump:

1. `bun typecheck` — 0 errors.
2. `bun test` — all suites pass.
3. `bun lint` — clean (run `bun format` to auto-fix what's safe).
4. Docs updated in the same commit as the code.
5. `package.json` lists the right `dependencies` (workspace refs) + `peerDependencies` (Bun types, optional integrations).
6. New `Schema`s exported from `src/index.ts`.
7. New `ServiceProvider`s exported from `src/index.ts`.
8. `docs/README.md` status table updated.
9. Lockstep version: `./scripts/sync-versions.sh set 1.0.0-alpha.<N>`.
10. Hand off to user for the `./scripts/publish.sh` step (npm 2FA flow is browser-interactive — see `feedback_publish_needs_user` in memory).

## Per-package implementation notes

Brief, opinionated starting hints for each remaining package. Read the corresponding `spec/<topic>.md` (where it exists) for the original design intent — but remember that `docs/` wins where they disagree.

### `@strav/workflow`

Pure functions on `kernel`. No I/O, no DB, no network. The hard part is **types**: each operator should typecheck input → output through chained steps.

- Primitives: `sequential`, `parallel`, `route` (pick a branch), `loop` (repeat until predicate).
- Saga: each step gets an optional `compensate` callback; failures invoke compensations in reverse order.
- No persistence — that's `@strav/durable`'s job.
- 0.x reference: `packages/workflow/` had ~600 LoC. Keep it under 1000.

Starting point: `defineWorkflow(name, fn)` returns a `Workflow<Input, Output>`. Make it composable — `parallel([a, b, c])` returns another `Workflow` that can feed into a `sequential`. Type inference here is the design.

### `@strav/machine`

Depends on `database` for the `stateful()` mixin only — the state-machine primitive itself is pure.

- `defineMachine({ states, transitions, guards })` returns a `Machine<State, Event>`.
- `machine.send(event, context)` returns the new state or throws on disallowed transitions.
- `stateful(model)` mixin: tracks a `state` column on a Repository, persists transitions atomically.
- Guards are functions; their async-ness is up to the caller.

Starting point: model the state machine as a pure transition table first. Add `stateful()` as a Repository extension that calls the pure primitive inside `Repository.update`.

### `@strav/durable`

The capstone. Combines:
- `@strav/queue` for execution (jobs ARE workflow steps).
- `@strav/machine` for the workflow's resumable state.
- `@strav/workflow` for the composition primitives.

Each step is a job; completing a step transitions the machine; crashes resume from the last committed step. Idempotency keys per step. **Tests are the design** — write the "kill the worker mid-step, restart, complete" test before the implementation.

### `@strav/brain`

Largest package after `database`. Folds in `@strav/brain/mcp` for tools.

- `Brain` class with provider drivers: Anthropic, OpenAI, Gemini, DeepSeek.
- `Agent` — has a system prompt + tools + a thread.
- `Thread` — message history, persisted optionally via `@strav/database`.
- `useTools([tool, tool])` — registers tools; the chosen provider routes through MCP.
- `Tool` + `defineTool({ name, description, schema, handle })` — in `brain/mcp` sub-path.

Provider drivers are pure-fetch (no SDKs) where possible — see `@strav/signal`'s Resend/SendGrid/Mailgun trio for the pattern. Streaming responses come back as `AsyncIterable<Chunk>`.

### `@strav/rag`

Drivers: pgvector + in-memory. `retrievable()` mixin gives a Repository a `.search(query, { topK })` method.

- Chunking strategies: fixed-size, sentence-aware, recursive. Pluggable.
- Embeddings: route through `@strav/brain`'s embeddings interface.
- `pgvector` driver requires the Postgres extension; document the install step.

### `@strav/social`

OAuth client (not server). Drivers per provider — Google, GitHub, Facebook, Microsoft, Apple.

- `SocialManager` with `redirect(driver)` + `callback(driver, code)`.
- Tokens stored in `strav_social_accounts` schema (user_id, provider, provider_user_id, tokens).
- HTTP routes: `/auth/<provider>/redirect` + `/auth/<provider>/callback` — apps wire these via a provider helper.

### `@strav/stripe` / `@strav/omise`

Vendor wrappers, not abstractions. Each package is a deep integration with one provider. No `@strav/payments` middle layer.

- Wrap the official SDK (`stripe` npm package, `omise` npm package).
- Webhook handler: signature verification + idempotency table to drop replays.
- `billable()` Repository mixin: subscriptions + invoices linked to a Model.

### `@strav/line`

LINE Messaging API: Flex Messages, Rich Menu, LIFF helpers.

- Depends on `@strav/signal` — LINE messages route through `MailManager`-equivalent abstractions.
- Webhook signature verification (LINE channel secret).
- SDK or pure-fetch? Probably pure-fetch — LINE's API is well-documented.

### `@strav/flag`

Feature flags with DB persistence + HTTP endpoints + console commands.

- `strav_feature_flags` schema (name, value, scope, conditions).
- `Flag.enabled(name, ctx?)` evaluates a flag.
- HTTP middleware that auto-attaches `ctx.flags` (like `ctx.auth`).
- `bun strav flag:list / flag:enable / flag:disable / flag:set`.

### `@strav/search`

FTS abstraction with pluggable drivers: Meilisearch, Typesense, pg (tsvector).

- `searchable()` Repository mixin: `.searchable({ fields: ['title', 'body'] })`.
- Driver interface: `index(model)`, `search(query, opts)`, `delete(model)`.
- pg driver uses `tsvector` columns + `to_tsquery`.
- Console: `search:reindex <model>`.

### `@strav/captcha`

Zero external dep. Honeypot field + proof-of-work + SVG renderer.

- Vue island for the client-side widget.
- Server-side verifier middleware.
- Stateless (proof-of-work) + stateful (honeypot replay protection) options.

### `@strav/devtools`

Dev-mode only. Request inspector, dev error page, performance probes, REPL extensions.

- Auto-bound when `APP_ENV=local` or `APP_ENV=development`.
- HTTP route `/__strav` for the inspector UI.
- Replaces the default `ExceptionHandler` with a friendlier dev page.

### `@strav/testing`

App factory, DB rollback wrap, request helpers, browser harness.

- `makeTestApp({ providers, schemas })` returns a booted `Application` for tests.
- `withRollback(fn)`: wraps `fn` in a transaction that's rolled back on exit — no test cleanup needed.
- Request helpers: `await app.get('/users').expect(200)`.
- `runCommand(app, 'cmd --flag')` for testing console commands (already prototyped — see `docs/cli/guides/custom-commands.md` snippet).

This is the one M4 package an app developer is most likely to want next. Worth prioritizing.

### `@strav/faker`

Deterministic. Seedable RNG → fake names, emails, addresses, paragraphs. **Not** `@faker-js/faker` — bring our own to keep determinism + bundle size honest.

- `faker = createFaker({ seed })` → seeded RNG.
- `faker.name()`, `faker.email()`, `faker.uuid()`, `faker.paragraph()`, etc.
- Locale-aware where it matters (names, addresses).

### `@strav/spring`

The scaffolder. Versions independently — see `spec/packages.md`. Two templates:

- `--web`: pages auto-router + island scaffolding + Tailwind.
- `--api`: JSON-only, no view layer.

Also ships `bunx @strav/spring port` codemod for mechanical 0.x → 1.x renames (the big ones: `BaseModel` → `Model + Repository`, `Emitter` → `EventBus`, route file format).

Spring **doesn't import the framework at runtime** — it only writes files. Its `package.json` lists framework packages in `peerDependencies` for the user's project, not its own `dependencies`.

## When in doubt

1. **Read the matching shipped package.** `auth` is the cleanest small subsystem; `database` is the most complex. For a manager + drivers package, copy `@strav/payment` (the canonical example). Whatever pattern you need, one of them probably has it.
2. **Writing a custom driver?** Read [building-an-adapter.md](./building-an-adapter.md) — registration patterns, the SDK-in-config gotcha, webhook contracts, the test ladder.
2. **Read the spec.** `spec/<topic>.md` (where it exists) captures the design intent. It's NOT authoritative for current API — `docs/` is — but it's load-bearing for the *why*.
3. **Read the project memory** — Claude Code stores per-project notes under `~/.claude/projects/<encoded-project-path>/memory/`. The `project_m*_progress.md` / `project_*_shipped.md` files there carry decision notes that didn't make it into spec or docs — the live "we tried this and it didn't work, so we did that" trail.
4. **Match the existing tests' style.** Bun's `describe / test / expect` shape with one-line test names, MemStream for output assertions, InMemoryDatabase / FakeQueue / etc. for test doubles.

Don't invent. Match.

## Open questions before starting M5

Worth resolving before any M5 package gets a line of code:

1. **Where does `@strav/durable`'s state live?** Same `strav_jobs` table with a `workflow_id` column, or a separate `strav_workflow_runs` table? The first is simpler; the second is cleaner separation.
2. **`@strav/brain` streaming**: Web Streams API throughout, or do providers return their native streaming primitives and we adapt? Web Streams is the cleaner public API but adds friction with Anthropic's SSE.
3. **`@strav/rag` embeddings cache**: in-process Map, Postgres table, or fully external (Redis)? The pgvector driver implies "use the DB you already have."
4. **`@strav/spring` 0.x → 1.x codemod scope**: how much of the migration do we automate? Schema definitions and route declarations are tractable; controllers and tests are not.

Surface these as ADRs in `docs/decisions/` once you have a leaning. Land the implementation after the decision, not before.
