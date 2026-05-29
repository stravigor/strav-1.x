# @strav/cli

CLI layer for Strav 1.0 — `Command` base, signature DSL, `ConsoleProvider`, interactive prompts, subset-boot, on top of `@strav/kernel`'s `ConsoleKernel`.

> **Status: 1.0.0-alpha.3 shipped; alpha.4 imminent (M4 closeout).** Public surface: `Command` + `parseSignature` + `bindArgv` + `ConsoleProvider` + `runCli` + `ExitCode` + every built-in command set listed below (database / queue / view / http / scaffold / util). `cache:*` / `tenant:*` / `plugin:*` are deferred — each lands when its underlying package or convention does (see "What's deferred").

## Install

```bash
bun add @strav/cli
```

Peer dep: `@strav/kernel` (already in the workspace). No native modules.

## Anatomy

```ts
// app/console/commands/tenant_backup.ts
import { inject } from '@strav/kernel'
import { Command, type ExecuteArgs } from '@strav/cli'
import { TenantManager } from '@strav/database'

@inject()
export class TenantBackup extends Command {
  static signature = 'tenant:backup {slug} {--output=storage/backups} {--compress}'
  static description = "Dump a tenant's data to a local backup file."

  constructor(private tenants: TenantManager) {
    super()
  }

  async execute({ args, flags }: ExecuteArgs): Promise<number> {
    const tenant = await this.tenants.findBySlug(args.slug as string)
    if (!tenant) {
      this.error(`Tenant not found: ${args.slug}`)
      return 65
    }
    const path = await this.tenants.dump(tenant.id, {
      output: flags.output as string,
      compress: flags.compress === true,
    })
    this.success(`Wrote ${path}`)
    return 0
  }
}
```

Register via a `ConsoleProvider` subclass:

```ts
// app/providers/console_provider.ts
import { ConsoleProvider } from '@strav/cli'
import { TenantBackup } from '../console/commands/tenant_backup.ts'

export class AppConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.app'
  override readonly commands = [TenantBackup] as const
}
```

Add it to `bootstrap/providers.ts` and `bun strav tenant:backup acme` runs.

## Signature DSL

The `static signature` is the source of truth for argv binding:

| Form | Meaning |
|---|---|
| `cmd` | The command name (first token; everything that follows is positional/flag). |
| `{slug}` | Required positional. Bound as `args.slug` (string). |
| `{target?}` | Optional positional. Bound as `args.target` (`string \| undefined`). |
| `{--out}` | Boolean flag (default `false`). `--out` flips to `true`. |
| `{--out=storage/backups}` | String flag with default. `--out=/tmp` overrides. |

Order rules: required positionals come before optionals. Names must be unique. Bad signatures throw `ConfigError` at registration — typos surface at boot, not at the user's first invocation.

## Output + prompts

`Command` ships helpers as methods on `this`:

```ts
this.line('plain output')
this.info('blue text')
this.success('green')
this.warn('yellow')
this.error('red — routed to stderr')

this.table(['Slug', 'Name'], rows.map((t) => [t.slug, t.name]))

const ok = await this.confirm('Drop the table?')
const name = await this.ask('Tenant name?', 'New Tenant')
const plan = await this.choice('Plan?', ['free', 'pro', 'enterprise'], 'free')
```

Prompts read from `Bun.stdin` and re-prompt on bad input.

## Per-command `--help`

`bun strav <cmd> --help` (or `-h`) short-circuits before `execute()` runs and prints a help message composed from `static description` + the parsed signature. Override `help()` to add examples / extra detail:

```ts
override help(): string {
  return [
    'Examples:',
    '  bun strav tenant:backup acme',
    '  bun strav tenant:backup acme --output=/tmp --compress',
  ].join('\n')
}
```

## Exit codes

| Code | Meaning | When |
|---|---|---|
| `0` | Success | `execute()` returned a number `0` or `void`. |
| `1` | Generic failure | An exception escaped `execute()`. |
| `2` | Usage error | Argv didn't match the signature (missing/extra positional, value-flag with no value). Auto-emitted by the Command base. |
| `64` | Config error | Apps return this for invalid configuration (e.g., `APP_KEY` missing). |
| `65` | Data error | Apps return this for missing data dependencies (e.g., DB unreachable). |
| `≥100` | Command-specific | Apps own this range. |

Reach for them via `ExitCode.UsageError` etc. — see `docs/cli/api.md`.

## Subset boot

Some commands don't need the full app. Declare a subset by provider name with `static providers`:

```ts
@inject()
export class KeyGenerate extends Command {
  static signature = 'key:generate'
  static description = 'Generate APP_KEY and write to .env'
  static providers = ['config', 'logger']

  constructor(private encryption: Cipher) {
    super()
  }

  override async execute(): Promise<number> {
    // …
    return 0
  }
}
```

| `static providers` | Behavior |
|---|---|
| Omitted | Boot the full default list from `bootstrap/providers.ts`. |
| `['config', 'database']` | Boot those + their transitive `dependencies = […]`. Topo-sorted. |
| `[]` | Boot nothing. The application is constructed empty. |
| Unknown name | `ConfigError` at command boot — message names the missing provider. |

See `docs/cli/guides/subset-boot.md` for when to use which.

## `bin/strav.ts`

The entry script is one line of glue:

```ts
#!/usr/bin/env bun
import { runCli } from '@strav/cli'
import { defaultProviders } from '../bootstrap/providers.ts'

const exit = await runCli({
  argv: process.argv.slice(2),
  defaultProviders,
})
process.exit(exit)
```

`runCli` walks `defaultProviders` once: any `ConsoleProvider` subclass contributes its `commands` array. Apps don't have to wire commands a second time.

## Built-in command sets shipped so far

| Package | Commands |
|---|---|
| `@strav/database` (`DatabaseConsoleProvider`) | `migrate` · `migrate:rollback` · `migrate:status` · `migrate:fresh` · `migrate:generate` — see `docs/database/guides/migrations.md` |
| `@strav/queue` (`QueueConsoleProvider`) | `queue:work` · `queue:retry` · `queue:flush` · `queue:failed` · `scheduler:work` · `scheduler:list` · `scheduler:run` — see `docs/queue/guides/console.md` |
| `@strav/view` (`ViewConsoleProvider`) | `view:cache` · `view:clear` · `view:build` |
| `@strav/http` (`HttpConsoleProvider`) | `serve` · `all` · `route:list` · `console` |
| `@strav/cli` (`ScaffoldConsoleProvider`) | `make:controller` · `make:middleware` · `make:request` · `make:model` (model_generator) · `make:repository` · `make:migration` · `make:seeder` · `make:factory` · `make:job` · `make:mail` · `make:notification` · `make:policy` · `make:provider` · `make:command` · `make:test` |
| `@strav/cli` (`UtilConsoleProvider`) | `key:generate` · `config:show` · `config:list` |
| `@strav/database` (additional) | `db:seed` |

## What's deferred

The original slice 7 plan included `cache:*` / `tenant:*` / `plugin:*`. Each is held until its prerequisite lands rather than shipping a stub:

| Command set | Blocked on |
|---|---|
| `cache:*` (`cache:clear`, `cache:flush`) | `@strav/cache` is not yet a package — caching primitives + driver registry need to ship first. |
| `tenant:*` (`tenant:create`, `tenant:list`, `tenant:backup`) | `TenantManager` is a runtime helper (`withTenant` / `withoutTenant`), not a CRUD manager. App-side tenant tables vary by repo — needs a generic convention or per-app subclass hook. |
| `plugin:install <pkg>` | Needs a `package.json#strav` metadata convention + a loader (`spec/implementation-plan.md` §4.6). Real design slice; landing post-1.0. |
| `db:setup-roles` | BYPASSRLS-role provisioning lives in app migrations today. A canonical command needs an opinionated role-naming convention first. |
