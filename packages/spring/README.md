# @strav/spring

Project scaffolder for Strav 1.0. Writes a working app skeleton you can boot in a single command.

```bash
bunx @strav/spring my-app --api
cd my-app
bun install
bun strav serve
# → listening on http://localhost:3000
```

See [`docs/spring/`](../../docs/spring/) for the full documentation and the [template-strategy ADR](../../docs/decisions/spring-template-strategy.md) for design notes.

## Status

- Slice A — `--api` template + CLI shell. **Shipped.**
- Slice B — `--web` template (`@strav/view` + Vue islands + plain CSS). **Shipped.**

The scaffolder is feature-complete for 1.0. Slice 5.17 (`port` codemod) is cancelled — no 0.x backward-compat commitment.
