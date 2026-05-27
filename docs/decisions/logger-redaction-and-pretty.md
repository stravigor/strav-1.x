# ADR: Custom redactor + inlined pretty formatter for the Logger

**Status:** Accepted (M2)
**Affects:** `@strav/kernel/logger`

## Context

`spec/errors-and-logging.md` specifies:

1. Redaction paths support `**.token` — a recursive wildcard that matches the field name at *any* depth.
2. A `pretty: true` mode on the `stderr` channel for local-dev readability.

Pino is the engine the spec mandates. Its built-in features cover only part of the surface:

- Pino's `redact` paths support `password`, `*.password`, exact nested paths, and array indices — but **not** deep recursive wildcards. The closest analog (`paths: ['**.token']`) is not part of Pino's syntax.
- Pino's pretty mode lives in a separate package, `pino-pretty`, which pulls in its own dependency tree and historically uses worker threads / transports.

## Decision

Two pivots from the "pure Pino" reading of the spec:

1. **Implement redaction in a Strav-owned walker** (`logger/redact.ts → compileRedactor`). The walker runs *before* Pino sees the fields object. The compiled redactor supports exact paths, `*` (one segment), and `**` (any depth, including zero) per the spec.

2. **Inline the `pretty: true` formatter** (`logger/destinations/pretty.ts → formatPretty`). A ~30-line single-line formatter that parses each emitted JSON line and renders `<time> <LEVEL> <msg> key=value …`. No color, no transport threads — just a stderr write through our destination wrapper.

`@strav/kernel` therefore depends on Pino only — no `pino-pretty`, no `fast-redact`-specific glue.

## Alternatives considered

- **Use Pino's `redact` + accept the deep-glob gap.** Drops a spec'd capability. Inconsistent with the redaction examples in `spec/errors-and-logging.md`.
- **Use Pino's `redact` + run a pre-pass for deep globs only.** Walks the object twice. More code than one walker. Splits the redaction story across two engines, making the failure modes harder to explain.
- **Depend on `pino-pretty`.** Pulls in a multi-megabyte tree (kleur, sonic-boom transport, etc.) for a local-dev convenience. Bun's worker-threads compat for Pino transports is improving but not bulletproof; an inline formatter avoids that risk entirely.
- **Drop `pretty: true` from M2 and let apps add `pino-pretty` themselves.** Spec calls it out by name; users expect it to "just work" on `bun dev`.

## Trade-offs

- **Redactor performance.** Our walker clones the fields object — no in-place mutation. `fast-redact` (Pino's engine) is faster on hot paths. For the typical request-log volume, this is not a hot path; for a high-throughput logging service it could be. If profiling shows it matters, we can swap the implementation behind `compileRedactor` without changing the public API.
- **Pretty formatter is intentionally minimal.** No color codes, no per-level formatting, no stack-trace pretty-printing. Apps that want a richer dev experience can install `pino-pretty` themselves and pipe stderr through it (or replace the channel destination); the framework does not block that.
- **Two redactor implementations in the wild.** Apps that read Pino docs may try to set `redact` on a raw Pino instance and be confused that Strav's path syntax differs. Mitigated by the logger guide and by the fact that Strav apps interact with `Logger`, not raw Pino.

## What this is NOT

- Not a wholesale replacement of Pino. The wire format, levels, serializers, and `child()` semantics remain Pino's.
- Not a "logger framework" — `Logger` stays a thin façade. The redactor and the pretty formatter are the only places where Strav-specific logic intercepts the log line.
