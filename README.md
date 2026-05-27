# Strav 1.0 — Specification Phase

This is the design home of **Strav 1.0**, a clean-break successor to the 0.x framework.

> Strav 0.x lives at `../strav` and will remain maintained until 1.x is stable. **No backward compatibility** is planned between the two.

## What is here

- [`spec/`](./spec) — frozen design documents (architecture, packages, conventions, lifecycles).
- [`guides/`](./guides) — developer-facing guides validating the DX before any code is written.

## Status

Pre-code. Specs and guides come first; user signs off; then implementation begins.

## Reading order

1. [`spec/packages.md`](./spec/packages.md) — the 1.0 package list and why.
2. [`spec/conventions.md`](./spec/conventions.md) — naming, files, events, errors.
3. [`spec/directory-structure.md`](./spec/directory-structure.md) — how an app is laid out.
4. [`spec/architecture.md`](./spec/architecture.md) — container, providers, kernels, plugins.
5. [`spec/lifecycles.md`](./spec/lifecycles.md) — boot, request, job, schedule, console.
6. [`guides/01-getting-started.md`](./guides/01-getting-started.md) — the on-ramp.

## Goals for 1.0

- **Coherent.** One way to do common things; locked abstractions; no orphan packages.
- **Laravel-tier DX on Bun.** Familiar patterns, modern runtime.
- **AI-native.** `@strav/brain` (with merged MCP) is core, not a bolt-on.
- **Honest about trade-offs.** No magical generators that hide intent.

## Non-goals for 1.0

- Backward compatibility with 0.x.
- An OAuth server (`oauth2` is dropped).
- A PDF library or multi-channel publisher (`pdf`, `publish` are dropped).
- Drop-in support for arbitrary databases (Postgres-only).
