# @strav/cli — API reference

> **Status:** Reflects what's implemented in M4 slice 1 — `Command` base + signature DSL + `bindArgv` + `ConsoleProvider` + `runCli` + per-command `--help` + subset boot + `ExitCode` + `UsageError`. Built-in commands land in later slices.

## Public exports

```ts
import {
  // Command base + metadata
  Command,
  type CliCommandClass,
  type CliCommandMeta,
  type ExecuteArgs,
  // Signature DSL
  parseSignature,
  type Signature,
  type PositionalArg,
  type FlagSpec,
  // Argv binding
  bindArgv,
  type BoundArgv,
  UsageError,
  // Provider + subset boot
  ConsoleProvider,
  collectCommands,
  selectProviders,
  // Entry point
  runCli,
  type RunCliOptions,
  // Exit codes
  ExitCode,
  type ExitCodeValue,
  // Built-in commands + their providers
  ConfigList,
  ConfigShow,
  KeyGenerate,
  ScaffoldConsoleProvider,
  UtilConsoleProvider,
  // `make:*` command classes (re-exported individually for app subclassing)
  MakeCommandFile,
  MakeController,
  MakeFactory,
  MakeJob,
  MakeMail,
  MakeMiddleware,
  MakeMigration,
  MakeModel,
  MakeNotification,
  MakePolicy,
  MakeProvider,
  MakeRepository,
  MakeRequest,
  MakeSeeder,
  MakeTest,
} from '@strav/cli'
```

## `Command`

Abstract base. Subclasses declare `static signature` + `static description` (+ optional `static providers`) and implement `execute(argv)`.

```ts
abstract class Command {
  abstract execute(argv: ExecuteArgs): CommandResult
  protected line(msg?: string): void
  protected info(msg: string): void
  protected success(msg: string): void
  protected warn(msg: string): void
  protected error(msg: string): void   // → stderr
  protected table(headers: readonly string[], rows: readonly (readonly string[])[]): void
  protected confirm(question: string, opts?: { defaultYes?: boolean }): Promise<boolean>
  protected ask(question: string, defaultValue?: string): Promise<string>
  protected choice<T extends string>(question: string, options: readonly T[], defaultValue?: T): Promise<T>
  help?(): string | undefined          // override to extend --help output
}

interface ExecuteArgs {
  args: Record<string, string | undefined>
  flags: Record<string, string | boolean>
}
```

Lifecycle inside `Command.handle()` (called by the kernel):

1. Look up `static signature` → parse once, cache per-class.
2. If `--help` or `-h` flag is set → print help, return `ExitCode.Success`.
3. Bind argv via `bindArgv(signature, ctx.argv)`. `UsageError` → print message + usage line on stderr, return `ExitCode.UsageError`.
4. Call `this.execute({ args, flags })`. A returned `number` → that exit code. `void` / `undefined` → `0`. Thrown exception → bubbles to the kernel, which prints + returns exit `1`.

## Signature DSL

```ts
function parseSignature(signature: string): Signature

interface Signature {
  name: string
  args: PositionalArg[]
  flags: FlagSpec[]
}

interface PositionalArg {
  name: string
  optional: boolean
}

type FlagSpec =
  | { kind: 'boolean'; name: string; default: false }
  | { kind: 'string'; name: string; default: string }
```

Grammar:

| Form | Result |
|---|---|
| `name` | First token of signature. Becomes `Signature.name`. |
| `{slug}` | Required positional. |
| `{target?}` | Optional positional. Must follow all required positionals. |
| `{--out}` | Boolean flag. Default `false`. |
| `{--out=value}` | String flag. Default `value`. First `=` splits name from value; subsequent `=` are part of the value. |

Bad signatures throw `ConfigError` at parse time:
- Empty signature.
- First token wrapped in `{}`.
- Required positional after an optional.
- Duplicate positional or flag name.
- Token outside `{}` after the command name.
- Unterminated `{`.
- Identifier contains characters outside `[a-zA-Z][a-zA-Z0-9_-]*`.

## `bindArgv`

```ts
function bindArgv(signature: Signature, parsed: ParsedArgv): BoundArgv

interface BoundArgv {
  args: Record<string, string | undefined>
  flags: Record<string, string | boolean>
}

class UsageError extends StravError {
  readonly code = 'cli.usage'
  readonly status = 2
}
```

Behaviour:

- Required positional missing → `UsageError("missing argument: <name>")`.
- Extra positional → `UsageError('unexpected argument: "value"')`.
- String flag with no value (bare `--out`) → `UsageError("flag --out requires a value")`.
- Boolean flag with explicit value (`--verbose=1`) → flag is `true` (value ignored — friendly to CI scripts).
- Undeclared flags pass through into `flags[<name>]` for ad-hoc inspection.

## `ConsoleProvider`

```ts
abstract class ConsoleProvider extends ServiceProvider {
  readonly commands: readonly CliCommandClass[]
}

function collectCommands(providers: readonly ServiceProvider[]): CliCommandClass[]
```

Subclass once per app, declare a `commands` array. `runCli` walks the default provider list and collects every `ConsoleProvider` subclass's commands.

## `runCli`

```ts
function runCli(opts: RunCliOptions): Promise<number>

interface RunCliOptions {
  argv: readonly string[]
  defaultProviders: readonly ServiceProvider[]
  /** Optional explicit list — overrides collection from `defaultProviders`. */
  commands?: readonly CliCommandClass[]
  /** Pre-built application (tests). */
  app?: Application
  output?: ConsoleOutputOptions
  /** Default `false` — console commands typically exit quickly. */
  signalHandlers?: boolean
}
```

Flow:

1. Parse argv (no app yet).
2. Find the matching `CliCommandClass` by signature first-token.
3. Apply `static providers` to filter `defaultProviders` (`selectProviders` does the work; transitive `dependencies = […]` are auto-included).
4. Delegate to `@strav/kernel`'s `ConsoleKernel.run(...)` for boot + dispatch + shutdown.
5. Return the dispatch exit code.

When the argv is `list` / `--help` / `-h` / empty → boots zero providers and prints the registered command list.

## `selectProviders`

```ts
function selectProviders(
  defaults: readonly ServiceProvider[],
  requested: readonly string[] | undefined,
  commandName: string,
): ServiceProvider[]
```

| `requested` | Returns |
|---|---|
| `undefined` | Full default list. |
| `[]` | Empty array. |
| `['a', 'b']` | `a` + `b` + every transitive `dependencies` entry, deduped. |
| name not in defaults | `ConfigError: Command 'X' declared provider 'Y' which is not in the default providers list`. |
| circular deps | `ConfigError: circular provider dependency while resolving 'X': a → b → a`. |

## `ExitCode`

```ts
const ExitCode = {
  Success: 0,
  GenericFailure: 1,
  UsageError: 2,
  ConfigError: 64,
  DataError: 65,
} as const
```

## `UtilConsoleProvider` — built-in utility commands

```ts
class UtilConsoleProvider extends ConsoleProvider {
  readonly commands = [KeyGenerate, ConfigShow, ConfigList]
}
```

Wire it in `bootstrap/providers.ts` alongside `DatabaseConsoleProvider` / `HttpConsoleProvider` / `ScaffoldConsoleProvider` to expose:

### `key:generate {--show} {--force}`

Generates 32 random bytes as a 64-char hex `APP_KEY`. Default writes to `.env` (create / append / update-in-place); `--show` prints to stdout instead; `--force` overwrites an existing key. `static providers = []` — boots nothing.

### `config:show <key> {--json}`

Reads `ConfigRepository.get(key)` and prints the result. Scalars print as-is; objects pretty-print as JSON; `--json` forces compact JSON for any value. Missing key → exit 65 with an error on stderr. `static providers = ['config']`.

### `config:list`

Prints every top-level config namespace alphabetically. Empty / `null` / `{}` values get a `(empty)` marker so apps can spot half-wired sections at a glance. `static providers = ['config']`.
