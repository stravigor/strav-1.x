/**
 * Pure CLI argument parser for `bunx @strav/spring`. Side-effect free so
 * `tests/unit/args.test.ts` can hit every branch without spawning a process.
 *
 * Surface:
 *   bunx @strav/spring <project-name> [--api|--web|-t api|web] [--db <name>]
 *                                     [--no-install] [-h|--help] [-v|--version]
 *
 * Validation rules:
 *   - Project name is required for a real run. Help / version short-circuit it.
 *   - Project name matches `/^[a-z0-9][a-z0-9_-]*$/` (no uppercase, no leading
 *     dot, no spaces). This is what npm packageName allows minus the scope.
 *   - `--template` / `-t` only accepts `api` or `web`. Conflicts between
 *     `--api` / `--web` / `--template` → error.
 */

import { SpringError } from './spring_error.ts'

export type Template = 'api' | 'web'

export interface ParsedArgs {
  /** Empty when the user just asked for help or version. */
  projectName?: string
  template?: Template
  dbName?: string
  noInstall: boolean
  help: boolean
  version: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { noInstall: false, help: false, version: false }
  let templateSeenAs: string | undefined

  const setTemplate = (value: string, flag: string): void => {
    if (value !== 'api' && value !== 'web') {
      throw new SpringError(`${flag}: expected "api" or "web", got "${value}"`)
    }
    if (out.template !== undefined && out.template !== value) {
      throw new SpringError(
        `${flag} conflicts with earlier ${templateSeenAs} (resolved to "${out.template}")`,
      )
    }
    out.template = value as Template
    templateSeenAs = flag
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      case '--api':
        setTemplate('api', '--api')
        break
      case '--web':
        setTemplate('web', '--web')
        break
      case '--no-install':
        out.noInstall = true
        break
      case '-t':
      case '--template': {
        const next = argv[++i]
        if (next === undefined) {
          throw new SpringError(`${arg}: missing value (expected "api" or "web")`)
        }
        setTemplate(next, arg)
        break
      }
      case '--db': {
        const next = argv[++i]
        if (next === undefined) {
          throw new SpringError(`--db: missing value (expected a database name)`)
        }
        out.dbName = next
        break
      }
      default: {
        if (arg.startsWith('-')) {
          throw new SpringError(`unknown option: ${arg}`)
        }
        if (out.projectName !== undefined) {
          throw new SpringError(
            `unexpected positional argument "${arg}" (project name "${out.projectName}" already set)`,
          )
        }
        if (!NAME_RE.test(arg)) {
          throw new SpringError(
            `invalid project name "${arg}" — must match /^[a-z0-9][a-z0-9_-]*$/ (lowercase letters, digits, hyphen, underscore)`,
          )
        }
        out.projectName = arg
        break
      }
    }
  }
  return out
}

/**
 * Convert a project name to a snake_case database default. Splits on `-`
 * and runs of non-alphanumerics. Mirrors what 0.x spring did so the
 * default `DB_DATABASE` value reads naturally for `my-blog` → `my_blog`.
 */
export function toSnakeCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
