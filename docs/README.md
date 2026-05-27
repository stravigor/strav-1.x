# Strav 1.0 — Documentation

This is the canonical, code-aligned documentation for Strav 1.0. Every package has its own folder; cross-cutting topics live at the top level.

## How this is organized

```
docs/
├── README.md             # you are here
├── decisions/            # ADRs for in-implementation design pivots
└── <package>/            # one folder per @strav/* package
    ├── README.md         # what it does, install, minimal example
    ├── api.md            # complete public API reference
    ├── guides/           # focused recipes
    └── reference/        # internals worth documenting (wire formats, etc.)
```

## Status

The framework is in **M2 (HTTP + Database)** implementation. Documentation lands package-by-package as packages ship:

| Package | Doc status |
|---|---|
| `@strav/kernel` | M1 complete + M2 `Logger` shipped; see `docs/kernel/` |
| `@strav/http` | M2 — Router, HttpContext, HttpKernel, middleware, ExceptionHandler, built-in middleware, FormRequest + `rule.*`; see `docs/http/` |
| `@strav/auth` | M2 foundation — Hasher, Authenticatable, Guard/AuthManager/AuthContext, MemoryGuard, auth/guest middleware; see `docs/auth/` |
| `@strav/database` | M2 foundation — Bun.SQL Database, defineSchema + Archetype + t.* builders, SchemaRegistry, MigrationRunner; see `docs/database/` |
| Others | Pending — land with their respective milestones (see `spec/implementation-plan.md`) |

## How to read

- **New to the framework?** Start at the top-level `docs/getting-started.md` (lands once the kernel is implementable).
- **Building an app?** Each package's `docs/<name>/README.md` is the on-ramp.
- **Need an API reference?** `docs/<name>/api.md` — every public export with signature, semantics, example.
- **Operational task** (deploy, multi-tenant setup, queues)? Look in `docs/<name>/guides/` or the top-level cross-cutting guides.

## Relationship to `spec/` and `guides/`

The `spec/` and `guides/` folders at the workspace root contain the **design-phase research** that shaped Strav 1.0. They are not the source of truth for shipped APIs — they captured the original intent. When `spec/` and `docs/` disagree, **`docs/` wins**.

If you're researching *why* a design choice was made, `spec/` is a good place to look. If you're learning how to *use* something, you want `docs/`.

## Decisions

`docs/decisions/` collects ADRs (Architecture Decision Records) for design pivots made during implementation. Each ADR explains:

- The decision.
- The context (what we were trying to do).
- The alternatives considered.
- The trade-offs.

ADRs are append-only — superseded ones stay in place, marked superseded, so the design history is auditable.
