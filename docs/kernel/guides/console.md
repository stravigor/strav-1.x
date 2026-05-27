# Console — commands and the kernel

The console kernel is the first transport layer on top of `Application`. It turns argv into a single command dispatch and an exit code. Same shape the HTTP and queue kernels will follow.

## A minimal command

```ts
// app/Console/Commands/hello_command.ts
import { Command, type CommandContext, inject } from '@strav/kernel'

@inject()
export class HelloCommand extends Command {
  static readonly signature = 'hello'
  static readonly description = 'Print a greeting'

  async handle(ctx: CommandContext): Promise<void> {
    const who = ctx.args[0] ?? 'world'
    ctx.out.line(`hello ${who}`)
  }
}
```

Run it:

```ts
// bin/strav.ts
import { ConsoleKernel } from '@strav/kernel'
import { HelloCommand } from '../app/Console/Commands/hello_command.ts'

const exitCode = await ConsoleKernel.run({
  argv: process.argv.slice(2),
  commands: [HelloCommand],
})
process.exit(exitCode)
```

```sh
$ bun bin/strav.ts hello
hello world

$ bun bin/strav.ts hello alice
hello alice

$ bun bin/strav.ts
Available commands:
  hello   Print a greeting
```

## Command anatomy

| Member | Kind | Purpose |
|---|---|---|
| `static signature` | string | The command name. May contain `:` (e.g. `make:controller`) or `-` (e.g. `db-seed`). |
| `static description` | string | One-liner shown in `list`. |
| `handle(ctx)` | method | The action. Returns `number` (exit code), `void` (→ 0), or `Promise<...>` of either. A thrown error → 1. |

Static fields are read at registration time **without instantiating the class**, which matters because commands with `@inject()` deps can only be safely constructed by the booted container.

## The `CommandContext`

```ts
interface CommandContext {
  readonly args: readonly string[]
  readonly flags: Readonly<Record<string, string | boolean>>
  readonly out: ConsoleOutput
  readonly app: Application
}
```

- `args` — positional tokens after the command name.
- `flags` — `--port=3000`, `--port 3000`, and `--verbose` all parse into `flags`. See "argv parsing" below.
- `out` — the writer. Prefer `out.success` / `out.warn` / `out.error` over raw `console.log` so color, stream routing, and test capture all just work.
- `app` — the booted Application, for ad-hoc `app.make(SomeService)`.

## Dependency injection

Commands are constructed via `app.make(Class)`, so `@inject()` works the same as anywhere else:

```ts
@inject()
export class MigrateCommand extends Command {
  static readonly signature = 'migrate'
  static readonly description = 'Run pending migrations'

  constructor(private migrator: Migrator) { super() }

  async handle(ctx: CommandContext): Promise<void> {
    const applied = await this.migrator.runPending()
    ctx.out.success(`${applied.length} migration(s) applied`)
  }
}
```

## Exit codes

```ts
async handle(ctx: CommandContext): Promise<number | void> {
  if (!ok) {
    ctx.out.error('precondition failed')
    return 2          // 2 = explicit usage error
  }
  // …
                       // implicit `void` → 0
}
```

- `void` / `undefined` → exit code 0
- `number` → that exit code
- thrown error → exit code 1, normalized via `asStravError`, message to stderr; in non-production a stack trace is appended

## Argv parsing — what's a flag?

```
hello                          → command: 'hello'
hello alice                    → args: ['alice']
hello --verbose                → flags: { verbose: true }
hello --name=alice             → flags: { name: 'alice' }
hello --name alice             → flags: { name: 'alice' }   ← next token consumed
hello -q                       → flags: { q: true }
hello -- --not-a-flag          → args: ['--not-a-flag']     ← `--` ends flag parsing
hello --port 3000 --verbose    → flags: { port: '3000', verbose: true }
```

Rules:

- `--flag` (alone) → boolean true.
- `--flag=value` → string value (unambiguous; preferred for scripts).
- `--flag value` → string value **iff** `value` doesn't start with `-`.
- `-f` → boolean true (single-char short flag).
- `--` → ends flag parsing; remaining tokens are positional.
- Repeating a flag is last-wins.

The `--flag value` form swallows the next token even when it might be a command name. **Put flags after the command**, or use `--flag=value` for safety.

## Special argv: list and help

| Argv | Result |
|---|---|
| `` (empty) | Print command list, exit 0 |
| `list` | Print command list, exit 0 |
| `--help` / `-h` | Print command list, exit 0 |
| `<unknown>` | Error to stderr, exit 1 |

## `ConsoleOutput`

Color is auto-detected from `stdout.isTTY` — pipe to a file and you get plain text. Force-enable or disable via the `useColor` option (also useful in tests).

```ts
out.line('plain text')           // stdout, no color
out.info('FYI')                  // blue
out.success('done')              // green
out.warn('careful')              // yellow
out.error('boom')                // red, stderr
out.write('no newline')          // raw stdout
out.writeError('no newline')     // raw stderr
```

Test-friendly construction:

```ts
const stdout = new MemStream()
const stderr = new MemStream()
const out = new ConsoleOutput({ stdout, stderr, useColor: false })
```

## Wiring providers + commands

`ConsoleKernel.run({...})` is the convenience entry. It accepts both providers and commands so a single `bin/strav.ts` can register everything:

```ts
import { ConsoleKernel } from '@strav/kernel'
import { ConfigProvider } from '@strav/kernel/providers'
import { configValues } from '../config/app.ts'
import { commands } from '../app/Console/Commands/index.ts'

const exitCode = await ConsoleKernel.run({
  argv: process.argv.slice(2),
  providers: [new ConfigProvider(configValues)],
  commands,
})
process.exit(exitCode)
```

`run` boots the app, dispatches one argv, then shuts the app down — clean for one-shot console invocations.

### Long-running console commands (workers, REPL)

For commands that need the app to live as long as they do (`queue:work`, `serve`, REPL), build the kernel manually:

```ts
const app = new Application()
app.useProviders([new ConfigProvider(configValues), new DatabaseProvider()])
await app.start({ signalHandlers: true })  // we want graceful Ctrl-C here

const kernel = new ConsoleKernel(app)
kernel.register(QueueWorkCommand)
const exitCode = await kernel.handle(process.argv.slice(2))

await app.shutdown()
process.exit(exitCode)
```

The pattern is: `signalHandlers: true` (let SIGINT trigger graceful shutdown) and you control the lifetime.

## Custom output for tests

```ts
import { MemStream } from './test-helpers'
import { ConsoleKernel, ConsoleOutput } from '@strav/kernel'

test('greet command prints to stdout', async () => {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const app = new Application()
  const kernel = new ConsoleKernel(
    app,
    new ConsoleOutput({ stdout, stderr, useColor: false }),
  )
  kernel.register(GreetCommand)
  await app.start({ signalHandlers: false })
  const code = await kernel.handle(['greet', 'alice'])
  await app.shutdown()
  expect(code).toBe(0)
  expect(stdout.text()).toBe('hello alice\n')
})
```

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `cannot make() class — application not started` | Calling `app.make` inside a command before the app booted | Use `ConsoleKernel.run` (boots automatically) or call `app.start()` before `kernel.handle` |
| `--verbose run` is read as `--verbose=run` | Token after `--flag` is consumed as the value | Put flags after the command, or use `--verbose=true` |
| Colored output in CI logs | `isTTY` is true on some CI runners | Set `useColor: false` explicitly when wiring `ConsoleOutput`, or honor a `NO_COLOR` env var in your bin script |
| Command runs but exit code is 0 even after a logged error | Returning `void` / no value | Either `return 1` or throw — both produce exit 1 |
| `Unknown command "foo bar"` when `foo bar` was meant as one arg | Shell didn't quote it | Quote in the shell: `bun bin/strav.ts greet "alice bob"` |
