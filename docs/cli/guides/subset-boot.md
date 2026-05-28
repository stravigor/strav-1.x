# Subset boot — `static providers`

Most console commands shouldn't pay the full-application boot cost. A `key:generate` command writes one file; booting the HTTP router, queue worker, and view engine to do it is wasted startup time. Declare a subset:

```ts
import { Command, ExitCode } from '@strav/cli'
import { inject, Logger } from '@strav/kernel'

@inject()
export class KeyGenerate extends Command {
  static signature = 'key:generate'
  static description = 'Generate APP_KEY and write to .env'
  static providers = ['config', 'logger']

  constructor(private logger: Logger) {
    super()
  }

  override execute(): number {
    // …
    return ExitCode.Success
  }
}
```

When `runCli` resolves `key:generate` to `KeyGenerate`, it reads `static providers = ['config', 'logger']`, walks the default provider list to find those (and any transitive `dependencies = [...]`), and passes only that filtered list to the application. The HTTP, view, queue, etc. providers never `register()` or `boot()`.

## Rules

| Value | Behavior |
|---|---|
| Omitted | Boot the full default list from `bootstrap/providers.ts`. |
| `['config', 'database']` | Boot those + their transitive `dependencies = [...]`. Topo-sorted as usual. |
| `[]` | Boot **no** providers. The Application is constructed empty. |
| Unknown name | `ConfigError: Command 'X' declared provider 'Y' which is not in the default providers list` at command boot. |

The transitive auto-include matters: if `DatabaseProvider.dependencies = ['config', 'logger']` and the command declares `['database']`, the framework includes `config` and `logger` automatically. You don't have to repeat the chain.

## When to use which

| Subset | For commands that… |
|---|---|
| `['config', 'logger']` | Just write to disk / stdout. `key:generate`, `make:*`, help-only paths. |
| `['config', 'logger', 'database']` | Need the DB but not HTTP / queue / mail. Migration commands, `db:seed`, `tenant:*`. |
| `['config', 'logger', 'database', 'queue']` | Drive the queue layer. `queue:work`, `queue:retry`, `queue:flush`. |
| Omitted | Run application code that may touch any subsystem. `console` (REPL), `tenant:backup`, custom commands that resolve repositories. |
| `[]` | Pure formatters, version probes, things that legitimately need nothing. |

## Provider names vs class identity

Subset filtering keys by `ServiceProvider.name` (a string), not the constructor identity. That's intentional: command files reference providers by name and never import the provider classes. Provider construction arguments stay in `bootstrap/providers.ts`.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `ConfigError: declared provider 'foo' which is not in the default providers list` | Name in `static providers` doesn't match any `ServiceProvider.name` in `bootstrap/providers.ts` | Verify the name; check the provider is in the default list. |
| Command can't `app.resolve(X)` | The provider that binds `X` wasn't included | Add the owning provider's name to `static providers`. |
| Slow boot for `make:*` commands | No `static providers` declared | Add `['config', 'logger']`. |
