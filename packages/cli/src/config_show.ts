/**
 * `bun strav config:show <key>` — print a single config value by dot-path.
 *
 * Resolves the value through `ConfigRepository.get`, which means apps see
 * the same lookup semantics here as in their providers — including any
 * env-var indirection / config decorators applied at boot.
 *
 * `--json` prints a compact JSON encoding (objects, arrays, numbers, …).
 * The default formatter handles scalars and objects sensibly so common
 * lookups (`config:show app.url`) "just work" without `--json`.
 *
 * Secret values: this command does **no** redaction. Apps that want to
 * audit secret access from the CLI should wrap config access in their
 * own provider or rely on the logger's redaction config when piping the
 * output to logs.
 */

import { ConfigRepository } from '@strav/kernel'
import { Command, type ExecuteArgs } from './command.ts'
import { ExitCode } from './exit_codes.ts'

export class ConfigShow extends Command {
  static signature = 'config:show {key} {--json}'
  static description = 'Print a config value by dot-path (e.g. config:show app.url).'
  static providers = ['config']

  override execute({ args, flags }: ExecuteArgs): number {
    const key = args.key as string
    const value = this.app.resolve(ConfigRepository).get(key)

    if (value === undefined) {
      this.error(`Config key not set: ${key}`)
      return ExitCode.DataError
    }

    if (flags.json === true) {
      this.line(JSON.stringify(value))
      return ExitCode.Success
    }

    if (value === null || typeof value !== 'object') {
      this.line(String(value))
      return ExitCode.Success
    }

    // Objects / arrays — pretty-print so nested config is readable.
    this.line(JSON.stringify(value, null, 2))
    return ExitCode.Success
  }
}
