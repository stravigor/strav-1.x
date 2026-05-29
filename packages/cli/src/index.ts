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
// Deferred to post-M4 slices (each lands when its underlying package does):
//   - `cache:*` — needs `@strav/cache` (not yet a package)
//   - `tenant:*` — needs a generic tenant-CRUD convention or app-side hooks
//   - `plugin:install` — needs `package.json#strav` metadata convention

export { type BoundArgv, bindArgv, UsageError } from './binder.ts'
export {
  type CliCommandClass,
  type CliCommandMeta,
  Command,
  type ExecuteArgs,
} from './command.ts'
export { ConsoleProvider, collectCommands } from './console_provider.ts'
export { ConfigList } from './config_list.ts'
export { ConfigShow } from './config_show.ts'
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
