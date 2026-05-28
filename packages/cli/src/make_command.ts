/**
 * `MakeCommand` — base for every `make:*` scaffold command.
 *
 * Subclasses implement `filePath(name)` and `stub(name)` and get the
 * filesystem write, exists-check, and directory creation for free.
 *
 * Naming helpers (`pascal`, `snake`, `camel`) convert the user's input
 * into the conventional forms each stub needs.
 *
 * Re-running against an existing file is a no-op with a warning —
 * there's no overwrite mode. Stubs can't safely re-derive what the user
 * has already edited.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Command, type ExecuteArgs } from './command.ts'
import { ExitCode } from './exit_codes.ts'

export abstract class MakeCommand extends Command {
  /** Destination path relative to `process.cwd()`. */
  protected abstract filePath(name: string): string
  /** File content to write. */
  protected abstract stub(name: string): string

  override async execute({ args }: ExecuteArgs): Promise<number> {
    const raw = (args.name ?? '').trim()
    if (!raw) {
      this.error('A name is required.')
      return ExitCode.UsageError
    }

    const dest = join(process.cwd(), this.filePath(raw))
    if (existsSync(dest)) {
      this.warn(`${dest} already exists — skipping. Delete it first to regenerate.`)
      return ExitCode.Success
    }

    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, this.stub(raw), 'utf8')
    this.success(`Created ${dest}`)
    return ExitCode.Success
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming helpers
// ─────────────────────────────────────────────────────────────────────────────

/** MyFoo / my_foo / my-foo → MyFoo */
export function pascal(name: string): string {
  return name
    .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase())
}

/** MyFoo / myFoo → my_foo */
export function snake(name: string): string {
  return pascal(name)
    .replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`)
    .replace(/^_/, '')
}

/** MyFoo → myFoo */
export function camel(name: string): string {
  const p = pascal(name)
  return p.charAt(0).toLowerCase() + p.slice(1)
}
