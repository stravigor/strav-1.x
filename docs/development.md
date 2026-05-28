# Local development

This guide covers the developer-machine setup beyond `bun install`: how to bring up the test Postgres, run the integration suite, and inspect the live database while iterating.

## Prerequisites

- Bun ≥ 1.3.14 (matches the version pinned in `package.json` and CI).
- Docker (or any local Postgres 16+) — only required if you want to run the integration / e2e tests. Unit tests are pure-Bun and don't need a database.

## Running the unit suite

```bash
bun install
bun typecheck
bun lint
bun test       # all unit tests + the e2e + integration suites
```

Integration tests **self-skip** when no Postgres is reachable, so `bun test` is a no-op for them in a fresh checkout. The unit tests run regardless.

## Running the integration suite against a real Postgres

The integration tests live at `tests/integration/`. They exercise what unit tests can't — real `Bun.SQL` connection, real DDL emission against the live planner, RLS policy enforcement, `TenantManager` round-trips.

### Option A: docker-compose (recommended)

```bash
docker-compose up -d            # bring up Postgres on :5432
cp .env.test.example .env.test
source .env.test
bun test:integration            # runs the integration suite
```

The compose file matches CI's `services.postgres` config, so behaviour is identical in both environments.

### Option B: your own Postgres

Export the five env vars by hand (or in your shell rc / direnv):

```bash
export DB_HOST=127.0.0.1
export DB_PORT=5432
export DB_USER=strav
export DB_PASSWORD=strav
export DB_DATABASE=strav_test
bun test:integration
```

The user / database must exist; the integration tests reset the `public` schema on each run.

### Resetting between runs

The integration suite already cleans up after itself, but if you need a hard reset (stuck state, half-applied migration, debugging):

```bash
bun db:setup
```

That runs `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` against the configured `DB_DATABASE`. Don't point `DB_DATABASE` at anything precious.

## CI

`.github/workflows/ci.yml` runs the same suite against a Postgres-16 service. The `DB_*` env vars are pre-set in the workflow, so the integration tests aren't skipped in CI — they run on every PR / push to `master`.

## Where things live

```
tests/
├── e2e/                    # per-milestone end-to-end smoke (real subprocess)
│   └── m1-boot/
├── integration/            # Postgres-required suites; self-skip without DB_*
│   └── postgres_smoke.test.ts
└── support/                # shared test helpers
    └── postgres_test_db.ts # connection + schema-reset helpers
```

## Common pitfalls

- **`bun test` shows `0 ran` for the integration suite** → env vars not exported. `source .env.test` or check `echo $DB_HOST`.
- **`ECONNREFUSED` on the first run** → Postgres isn't up yet. `docker-compose ps` to check; the healthcheck takes a few seconds on cold start.
- **Stuck advisory locks after a crashed test** → not possible by design. The framework uses transaction-level advisory locks (`pg_advisory_xact_lock`), which auto-release at COMMIT/ROLLBACK. If a test leaves a session lock, that's a bug — file an issue.
- **`bun db:setup` wipes data I cared about** → `DB_DATABASE` must point at a dedicated test database. The script is intentionally destructive. Keep your dev / staging / prod URLs elsewhere.
