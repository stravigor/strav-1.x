/**
 * `UtilConsoleProvider` — utility commands that don't belong to a specific
 * package (key generation, future: config:cache, config:clear).
 *
 * These commands set `static providers = []` — they write to disk and
 * need no app services.
 */

import { ConsoleProvider } from './console_provider.ts'
import { KeyGenerate } from './key_generate.ts'

export class UtilConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.util'
  override readonly commands = [KeyGenerate] as const
}
