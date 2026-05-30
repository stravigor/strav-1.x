# ADR: `@strav/spring` template strategy

**Status:** Accepted (M5 — slices A + B shipped 2026-05-30)
**Affects:** `@strav/spring`

## Context

Spring scaffolds Strav apps. Two design questions need decisions before code lands, because each shapes the package's whole structure:

1. **How are templates stored?** As literal files copied verbatim, or as code that emits files?
2. **How does the generated app pin framework versions?** What goes in the generated `package.json`?

> Note: an earlier draft of this ADR carried a third question about the `port` 0.x→1.x codemod. That slice is **cancelled** — Strav 1.0 makes no backward-compatibility commitment to 0.x, so the migration is a manual rewrite rather than a tooled one. The codemod section is omitted.

Spring is independent of the framework runtime (it lists no `@strav/*` in its own `dependencies`). That constraint forces every answer.

## Decision

### 1. Templates are literal files in `packages/spring/src/templates/`

Walk the tree, copy each file to the destination, run `.tt` files through a tiny string-template pass. No JSX-style generation, no AST emission.

```
packages/spring/src/templates/
├── shared/                      # written for every template
│   ├── .env.tt
│   ├── .env.example.tt
│   ├── .gitignore
│   ├── README.md.tt
│   ├── package.json.tt
│   ├── tsconfig.json
│   ├── bin/strav.ts
│   ├── bootstrap/{app,providers}.ts
│   ├── config/{app,auth,cache,database,http,logger,mail,queue,session}.ts.tt
│   ├── app/.../...
│   ├── database/.../...
│   ├── routes/{api,console}.ts
│   ├── storage/.gitkeep (×3)
│   └── tests/.../...
├── api/                         # overlay applied when --api
│   └── routes/api.ts            # API-shaped index route
└── web/                         # overlay applied when --web
    ├── config/view.ts.tt
    ├── public/index.html
    ├── public/assets/.gitkeep
    ├── resources/.../...
    ├── routes/web.ts
    ├── routes/broadcast.ts
    └── tests/browser/example.test.ts
```

**Why literal files**: diff-friendly. A contributor opening the templates folder sees what a generated project looks like, immediately. Code-emitting scaffolders (Yeoman, hygen-without-files, etc.) become opaque the moment you need to know "what does the output look like?" — you have to run them to find out. Strav is small enough that the file count is bounded (~80 across both templates) and the cost of literal files is low.

**File naming**: a `.tt` suffix marks a file that has interpolated tokens (`{{projectName}}`, `{{dbName}}`, `{{stravVersion}}`). Plain files are copied byte-for-byte. The scaffolder strips the `.tt` suffix on write.

**Interpolation is dumb**: `{{name}}` → replace. No conditionals, no loops. If a file needs conditional content, it belongs in a different template overlay. Mustache-by-hand, ~10 lines. No dependency.

### 2. Generated `package.json` pins framework packages to spring's own framework-version constant

Generated `package.json.tt`:

```jsonc
{
  "name": "{{projectName}}",
  "type": "module",
  "scripts": {
    "strav": "bun bin/strav.ts",
    "dev":   "bun --hot bin/strav.ts serve",
    "test":  "bun test"
  },
  "dependencies": {
    "@strav/kernel":   "{{stravVersion}}",
    "@strav/http":     "{{stravVersion}}",
    "@strav/database": "{{stravVersion}}",
    "@strav/auth":     "{{stravVersion}}",
    "@strav/cache":    "{{stravVersion}}",
    "@strav/queue":    "{{stravVersion}}",
    "@strav/mail":     "{{stravVersion}}",
    "@strav/cli":      "{{stravVersion}}"
    // + @strav/view, @strav/broadcast on --web overlay
  },
  "devDependencies": {
    "@types/bun":      "latest",
    "@strav/testing":  "{{stravVersion}}"
  }
}
```

`{{stravVersion}}` is a string constant in `packages/spring/src/version.ts`, e.g. `'^1.0.0-alpha.27'`. Spring's release process bumps it explicitly — it does NOT auto-track spring's own version (spring versions independently per `spec/packages.md`).

**Why a single constant, not separate per-package pins**: every shipped milestone version is lockstep across all `@strav/*` packages (per `CLAUDE.md §Versioning`). One constant is the truth.

**Why not `peerDependencies` in spring's own `package.json`**: `docs/contributing/implementing-a-package.md` originally said this, but it's a misread of what peerDependencies do. Spring's `package.json` describes what *spring* needs (nothing at runtime); the generated app's `package.json` describes what the *app* needs. Those are different files. The generated app uses `dependencies`, not peerDependencies — it's an application, not a library.

**Spring's own `package.json`** lists zero `@strav/*` packages. Only `@types/bun` and a test framework if needed.

## Consequences

- Spring's `src/templates/` will be ~80 files at steady state. Reviewer cost is real but bounded.
- Bumping the framework alpha requires bumping the `stravVersion` constant in `packages/spring/src/version.ts` as part of the release script. Add to `scripts/publish.sh` or note in [[feedback-publish-needs-user]].
- Generated apps get the **lean** dependency set — `@strav/{kernel,http,cli}` for `--api`; `--web` adds `@strav/view` + `vue` + `@vue/compiler-sfc`. Not the full alpha lockstep. Adding `@strav/database`, `@strav/auth`, `@strav/queue`, … is a one-liner per package (install + add config file + register provider). The "ship every dep" alternative considered in an earlier draft was rejected: it forces the user to spin up Postgres / Redis / etc. before `bun strav serve` succeeds, which kills the "scaffolds + boots in < 1s" gate.
- The `--web` template ships **plain CSS** (`resources/css/app.css`), not Tailwind. Same reasoning as the lean deps: Tailwind adds a build step + config files that the user may not want, and swapping it in is one `bun add` + one `<link>` change away. Spec mentioned Tailwind under "what the template includes" — that was design-phase intent and is superseded by the lean precedent set in slice A.
- Slice B surfaced two upstream gaps that were fixed in-flight:
  - `@strav/view`'s `ViewProvider.boot()` was gating the pages auto-router on `app.has('router')` (a string alias `@strav/http` doesn't bind). Now gates on `app.has(Router)` with a try/catch around the dynamic `@strav/http` import — pages auto-router fires for any app that registers both providers.
  - `@strav/http` grew `config.http.publicDir`. When set, GET/HEAD requests the router doesn't match fall back to a file lookup under `publicDir` (with `..` rejection). The scaffolded `--web` template uses this instead of a hand-rolled `/assets/*` route.

## Open questions

- ~~Should `--api` skip `config/{mail,session,view}.ts`?~~ **Resolved by lean default**: `--api` scaffolds `config/{app,http,logger}.ts` only. Other packages bring their own configs when the user adds them.
