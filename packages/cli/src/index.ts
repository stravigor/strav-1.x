// Public API of @strav/cli.
//
// Adds the signature DSL (`'cmd {arg} {arg?} {--flag=default}'`), a richer
// `Command` base with output helpers + interactive prompts, `ConsoleProvider`
// for command registration, subset boot (`static providers = [...]`), and
// `runCli` as the entry point for `bin/strav.ts`.
//
// Built on @strav/kernel's `Command` / `ConsoleKernel` — those stay as the
// minimal infrastructure; @strav/cli is the productive developer surface.
//
// Still deferred (each is its own slice):
//   - Migration commands (`migrate`, `migrate:rollback`, …) — slice 2
//   - Queue + scheduler commands — slice 3
//   - View commands — slice 4
//   - Server commands (`serve`, `all`, `console`) — slice 5
//   - `make:*` scaffolding + `model_generator` — slice 6
//   - Key / cache / db / tenant / plugin commands — slice 7

export { type BoundArgv, bindArgv, UsageError } from './binder.ts'
export {
  type CliCommandClass,
  type CliCommandMeta,
  Command,
  type ExecuteArgs,
} from './command.ts'
export { ConsoleProvider, collectCommands } from './console_provider.ts'
export { ExitCode, type ExitCodeValue } from './exit_codes.ts'
export { KeyGenerate } from './key_generate.ts'
export {
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
} from './make/index.ts'
export {
  camel,
  MakeCommand as MakeCommandBase,
  pascal,
  snake,
} from './make_command.ts'
export { type RunCliOptions, runCli } from './run_cli.ts'
export { ScaffoldConsoleProvider } from './scaffold_console_provider.ts'
export {
  type FlagSpec,
  type PositionalArg,
  parseSignature,
  type Signature,
} from './signature.ts'
export { selectProviders } from './subset_boot.ts'
export { UtilConsoleProvider } from './util_console_provider.ts'
