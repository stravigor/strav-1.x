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

M1 + M2 + M3 shipped to npm as `1.0.0-alpha.3` (2026-05-28). M4 (`@strav/cli`) is next. Documentation lands package-by-package as packages ship:

| Package | Doc status |
|---|---|
| `@strav/kernel` | M1 + M2 shipped (`1.0.0-alpha.3`); see `docs/kernel/` |
| `@strav/http` | M2 shipped (`1.0.0-alpha.3`); see `docs/http/` |
| `@strav/auth` | M2 shipped (`1.0.0-alpha.3`); see `docs/auth/` |
| `@strav/database` | M2 shipped (`1.0.0-alpha.3`) + `generateMigration` alter-column drift detection landed in alpha.3; see `docs/database/` |
| `@strav/queue` | M3 shipped (`1.0.0-alpha.3`); `Job` + `JobRegistry` + `Queue` + `SyncQueue` + `DatabaseQueue` + `Worker` + `Scheduler` + `failedJobsSchema` all landed. Only `queue:retry` / `queue:flush` console commands remain (wait on `@strav/cli` in M4). See `docs/queue/` |
| `@strav/signal` | M3 shipped (`1.0.0-alpha.3`); mail layer + HTTP transport trio (`Message` + `Transport` + `Array` / `Log` / `Resend` / `SendGrid` / `Mailgun` transports + `MailTransportError` + `MailManager` + `MailProvider` + `Mailable`). All pure-fetch, no `nodemailer`. Inbound parsers, notifications, broadcast, SSE still to come. See `docs/signal/` |
| `@strav/view` | M3 + M4: engine + islands + console commands + pages auto-router (`resources/views/pages/**/*.strav` → routes). See `docs/view/` |
| `@strav/cli` | M4 slices 1-5 in workspace: foundation + database migrate + queue/scheduler + view + HTTP server (`serve` / `all` / `route:list` / `console`). Slices 6-7 ahead (make/scaffolding / key+plugin). See `docs/cli/` |
| Others | Pending — land with their respective milestones (see `spec/implementation-plan.md`) |

## How to read

- **New to the framework?** Start at the top-level `docs/getting-started.md` (lands once the kernel is implementable).
- **Building an app?** Each package's `docs/<name>/README.md` is the on-ramp.
- **Need an API reference?** `docs/<name>/api.md` — every public export with signature, semantics, example.
- **Operational task** (deploy, multi-tenant setup, queues)? Look in `docs/<name>/guides/` or the top-level cross-cutting guides.
- **Implementing a remaining `@strav/*` package?** `docs/contributing/implementing-a-package.md` — patterns, conventions, and per-package starting hints distilled from the eight shipped packages.

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
