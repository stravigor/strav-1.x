# `@strav/spring`

> **Status:** Slices A + B shipped — `--api` and `--web` templates both scaffold and boot end-to-end. The scaffolder is feature-complete for 1.0.

The Strav project scaffolder. Run it once, get a working app:

```bash
bunx @strav/spring my-app           # interactive — picks template
bunx @strav/spring my-app --api     # JSON-only REST template
bunx @strav/spring my-app --web     # full-stack: pages auto-router, islands, Tailwind
```

Spring is **independent of the framework runtime**. It writes files; it does not import `@strav/*` at runtime. Its own `package.json` declares no `@strav/*` dependencies. Generated apps depend on the framework; spring itself does not. This is what lets spring version on its own cadence (see `spec/packages.md`).

> **No `port` codemod.** Strav 1.0 is a breaking-clean successor with no backward-compatibility commitment to 0.x; the original M5 slice 5.17 (`bunx @strav/spring port`) is **cancelled**. 0.x → 1.x migration is a manual rewrite informed by `spec/migration-0x-to-1x.md`.

## What "working app" means

After `bunx @strav/spring my-app --api`:

```
cd my-app
bun install      # already done by spring
bun strav serve  # boots in < 1s, GET /healthz returns 200
```

After `bunx @strav/spring my-app --web`, the same + a hello-world page at `/` rendered by the `.strav` engine with one Vue island.

That is the validation gate from `spec/implementation-plan.md §M5 Validation`.

## Generated layout

Matches `spec/directory-structure.md §Application layout`. The `--api` template (slice A) ships a **lean** dependency set — `@strav/{kernel,http,cli}` only — so a fresh app boots without external services. Adding `@strav/database`, `@strav/auth`, etc. is a one-liner per package (`bun add @strav/<name>` + a new `config/<name>.ts` + a provider in `bootstrap/providers.ts`). See the scaffolded `README.md`.

| Directory / file | `--api` | `--web` |
|---|---|---|
| `app/{console,exceptions,http/{controllers,middleware,requests},jobs,mail,models,notifications,policies,providers,repositories}/` | yes | yes |
| `bin/strav.ts` | yes | yes |
| `bootstrap/{app,providers}.ts` | yes | yes |
| `config/{app,http,logger}.ts` | yes | yes |
| `config/view.ts` | no | yes |
| `database/{factories,migrations,schemas,seeders}/` (empty placeholders) | yes | yes |
| `public/assets/` | no | yes |
| `resources/css/app.css` | no | yes |
| `resources/ts/islands/{setup.ts,counter.vue}` | no | yes |
| `resources/views/{layouts/app.strav,pages/index.strav,errors/{404,500}.strav,components/}` | no | yes |
| `routes/{api,console}.ts` | yes | yes |
| `routes/{web,broadcast}.ts` | no | yes |
| `storage/{cache,logs,uploads}/` (gitkeep + .gitignore rule) | yes | yes |
| `tests/{feature,unit}/` (sample `healthz.test.ts` under feature/) | yes | yes |
| `tests/browser/` (gitkeep — Playwright is user-installed) | no | yes |

> **Why lean by default?** Earlier drafts of the template-strategy ADR called for scaffolding every default-dependency at install time and letting users delete what they don't need. In practice "fresh app should boot without external services" matters more — listing `@strav/database` as a dep means the user has to spin up Postgres before `bun strav serve` works. The lean default gives a green path; opt-in additions stay explicit and trivial.
>
> **`--web` deps**: `@strav/{kernel,http,view,cli}` plus `vue` (dep) + `@vue/compiler-sfc` (devDep). No Tailwind, no PostCSS — plain CSS only. Swapping in Tailwind / vanilla-extract / your CSS stack of choice is a `bun add` + one `<link>` swap in `resources/views/layouts/app.strav`.

## CLI surface

```
bunx @strav/spring <project-name> [options]

  --api                       Headless REST template
  --web                       Full-stack template (Vue islands + .strav views + Tailwind)
  --template, -t api|web      Alias for --api / --web
  --db <name>                 Database name (default: snake_case(project-name))
  --no-install                Skip `bun install` after scaffolding
  -h, --help                  Show help
  -v, --version               Show spring version
```

Non-interactive runs error if `<project-name>` is missing. Interactive runs prompt for template only (db name defaults from project name; can override with `--db`).

Project name validation: `/^[a-z0-9][a-z0-9_-]*$/`. Reject UPPERCASE, dots, starting digit's hyphen, etc.

## Slicing — shipped

| Slice | Spec ID | Status |
|---|---|---|
| **A — Foundation + `--api`** | 5.14 + 5.16 | ✅ shipped 2026-05-30. Package skeleton, CLI shell, `--api` template, e2e fixture at `tests/e2e/spring-api/`. |
| **B — `--web`** | 5.15 | ✅ shipped 2026-05-30. Full-stack overlay (`@strav/view` + Vue islands + plain CSS + pages auto-router). e2e fixture at `tests/e2e/spring-web/` proves `GET /` renders `resources/views/pages/index.strav` with the `@island('Counter')` placeholder. |

Slice 5.17 (`port` codemod) is **cancelled** — Strav 1.0 has no backward-compatibility commitment to 0.x.

## What spring does *not* do

- **No app upgrades between framework versions.** Generated apps own their files. To upgrade, the user reads the changelog.
- **No "smart" detection.** No reading existing config to "merge". `--web` and `--api` are the only modes.
- **No template registry.** Two templates, in-tree. No `--template some-community-template`.
- **No interactive feature selection.** "Pick your auth driver", "pick your queue driver" — no. The scaffolded `config/*.ts` includes the default driver; users edit it.

These exclusions are deliberate. Every one of them is the kind of feature that grows into a maintenance sink in scaffolders.

## See also

- [Template strategy ADR](../decisions/spring-template-strategy.md) — pinning, peerDependencies, the codemod scope question.
- `spec/directory-structure.md` — frozen layout that spring writes.
- `docs/contributing/implementing-a-package.md §@strav/spring` — why spring is runtime-independent.
