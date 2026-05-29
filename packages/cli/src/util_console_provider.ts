/**
 * `UtilConsoleProvider` — utility commands that don't belong to a specific
 * package (key generation, config introspection).
 *
 * `KeyGenerate` sets `static providers = []` (writes to disk, no app services).
 * `ConfigShow` / `ConfigList` set `static providers = ['config']` to read
 * from the booted `ConfigRepository`.
 */

import { ConfigList } from './config_list.ts'
import { ConfigShow } from './config_show.ts'
import { ConsoleProvider } from './console_provider.ts'
import { KeyGenerate } from './key_generate.ts'

export class UtilConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.util'
  override readonly commands = [KeyGenerate, ConfigShow, ConfigList] as const
}
