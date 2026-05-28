/**
 * `bun strav key:generate` — generate APP_KEY and write it to `.env`.
 *
 * Generates 32 cryptographically-random bytes and hex-encodes them (64
 * chars). This format matches `parseEncryptionKey()` in `@strav/kernel/encryption`
 * so the value can be used directly as `config.encryption.key`.
 *
 * Behaviour:
 *   - If `.env` doesn't exist, creates it with `APP_KEY=<key>`.
 *   - If `.env` exists and already has `APP_KEY=`, updates the line.
 *   - If `.env` exists without `APP_KEY=`, appends the line.
 *   - `--show` prints the key to stdout instead of writing to disk
 *     (useful when your secret manager reads from stdout).
 *   - `--force` regenerates and overwrites even when APP_KEY is already set.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Command, type ExecuteArgs } from './command.ts'
import { ExitCode } from './exit_codes.ts'

export class KeyGenerate extends Command {
  static signature = 'key:generate {--show} {--force}'
  static description = 'Generate APP_KEY and write it to .env.'
  static providers: string[] = []

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const envPath = join(process.cwd(), '.env')
    const show = flags.show === true
    const force = flags.force === true

    // Read existing .env content (may not exist)
    let existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : ''

    // Guard: don't overwrite unless --force
    if (!force && existing.match(/^APP_KEY=.+/m)) {
      this.warn('APP_KEY already set in .env. Use --force to overwrite.')
      return ExitCode.Success
    }

    // Generate 32 random bytes → 64-char hex string
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

    if (show) {
      this.line(`APP_KEY=${key}`)
      return ExitCode.Success
    }

    if (existing.match(/^APP_KEY=/m)) {
      // Replace the existing APP_KEY line
      existing = existing.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
    } else {
      // Append (with a trailing newline)
      existing = existing.trimEnd()
      existing = existing ? `${existing}\nAPP_KEY=${key}\n` : `APP_KEY=${key}\n`
    }

    await writeFile(envPath, existing, 'utf8')
    this.success(`APP_KEY written to ${envPath}`)
    this.info('Add it to your shell with: source .env  (or use dotenv)')
    return ExitCode.Success
  }
}
