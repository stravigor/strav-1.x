# Strav 1.0 — Workspace Notes for AI Assistants

This is the implementation home of **Strav 1.0**, a Bun-first AI-native backend framework. It is a **breaking-clean successor** to 0.x at `../strav` — no compatibility shims.

## Documentation policy — read this first

There are three documentation surfaces in this repo. They serve different purposes and have different authority.

| Surface | Status | Purpose |
|---|---|---|
| **`docs/`** | **Canonical, code-aligned** | Real package documentation. Kept in sync with shipping code. The source of truth from here on |
| **`spec/`** | Preliminary research | Design-phase artifacts. Captures the *intent* and the *reasoning* for the 1.0 design. **Not** the source of truth for implementation specifics — those drift, and `docs/` wins when they diverge |
| **`guides/`** | Preliminary research | Same status as `spec/`. Useful for understanding the original developer-experience goals; not authoritative for current API |

### Practical implications

1. **When implementing a feature**: write/update `docs/<package>/` in the same commit. Treat it as part of the deliverable, not a follow-up.
2. **When `spec/` or `guides/` disagrees with `docs/`**: `docs/` wins. Don't update `spec/` to match — those are frozen-as-of-design-phase artifacts, archival reading.
3. **When users ask "where is X documented?"**: answer with `docs/`. Mention `spec/` only as context for "why was this designed this way?"
4. **New design decisions during implementation**: land them in `docs/`, not in `spec/`. If a design pivot is large enough to need its own write-up, add `docs/decisions/<topic>.md` (an ADR).
5. **`spec/implementation-plan.md`** remains useful as a milestone checklist — but task-list state is informational, not authoritative. Track real progress in commits + the `docs/` evolution.

### docs/ structure

```
docs/
├── README.md                  # top-level overview, navigation
├── decisions/                 # ADRs for in-implementation design pivots
└── <package>/                 # one folder per @strav/* package
    ├── README.md              # what it does, install, minimal example
    ├── api.md                 # complete public API reference (every export)
    ├── guides/                # focused recipes — auth, multi-tenancy, etc.
    └── reference/             # internals worth documenting (e.g., wire formats)
```

Every package ships its own `docs/<name>/`. Cross-package guides (architecture, lifecycles, deployment) live at `docs/<topic>.md` at the top level.

## Repository layout

```
strav-1.x/
├── packages/         # 27 framework packages
├── docs/             # canonical documentation (code-aligned)
├── tests/e2e/        # cross-package end-to-end smoke tests
├── scripts/          # publish, version-sync, db-setup
├── spec/             # preliminary research — design intent (archival)
├── guides/           # preliminary research — original DX goals (archival)
└── .github/          # CI
```

## Conventions

Naming + file-org rules (still authoritative because they don't change):

- **Classes** PascalCase, **methods** camelCase, **files/folders** snake_case, **DB** snake_case, **URLs** kebab-case, **events** dot.case.
- Every public symbol exported from a package's `src/index.ts` barrel.
- One public symbol per file. File name = primary export, snake_cased.
- No static singletons. Use the container.
- No `throw new Error('string')` — typed `StravError` subclasses only.
- TypeScript strict + `noUncheckedIndexedAccess` + `noImplicitOverride`.

## Commands

```bash
bun install              # install workspace deps
bun typecheck            # 0 errors required
bun test                 # all suites must pass (integration self-skips without Postgres)
bun test:e2e             # end-to-end smoke tests
bun test:integration     # Postgres-required suites (needs DB_* env vars or docker-compose up)
bun db:setup             # reset the test Postgres (drops + recreates `public` schema)
bun lint                 # Biome check
bun format               # Biome format --write
```

Local Postgres: `docker-compose up -d && cp .env.test.example .env.test && source .env.test`. See `docs/development.md` for the full setup.

## Versioning

Lockstep across packages until 1.0 GA. The version scheme is `1.0.0-alpha.N` during M1–M5 implementation, then `1.0.0-beta.N` → `1.0.0-rc.N` → `1.0.0`.

## When working in this repo

1. Read the relevant `docs/<package>/` (or its absence — if missing, you're writing both the feature and its docs).
2. Skim `spec/` only when you need the *why*. Don't trust it for current API shape.
3. Write the failing test first when feasible.
4. Run `bun typecheck && bun test` before committing.
5. **Doc-with-code rule**: every implementation change ships with the `docs/` update in the same commit. No "I'll document it later."
6. Don't add features beyond the current milestone — defer is fine, premature is not.
