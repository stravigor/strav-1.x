/**
 * `ConsoleProvider` — declares a set of console `Command` classes the app
 * registers with the `CliConsoleKernel`.
 *
 * Apps subclass it once in `app/providers/console_provider.ts`:
 *
 * ```ts
 * import { ConsoleProvider } from '@strav/cli'
 * import { TenantBackup } from '../console/commands/tenant_backup.ts'
 *
 * export class AppConsoleProvider extends ConsoleProvider {
 *   override readonly name = 'console.app'
 *   override readonly commands = [TenantBackup] as const
 * }
 * ```
 *
 * `runCli({ defaultProviders })` walks the provider list once, pulls every
 * `commands` array off subclasses, and hands the union to the
 * `CliConsoleKernel`. Apps don't have to wire commands a second time.
 *
 * The provider doesn't do anything at `register()` — command collection
 * happens before the app boots so subset-boot (`static providers`) can
 * pre-filter the provider list.
 */

import { ServiceProvider } from '@strav/kernel'
import type { CliCommandClass } from './command.ts'

export abstract class ConsoleProvider extends ServiceProvider {
  /** Commands this provider contributes. Override in subclasses. */
  readonly commands: readonly CliCommandClass[] = []
}

/**
 * Collect every command across an ordered provider list. Order matches the
 * iteration; duplicate-by-signature is caught later by `CliConsoleKernel`.
 */
export function collectCommands(providers: readonly ServiceProvider[]): CliCommandClass[] {
  const out: CliCommandClass[] = []
  for (const provider of providers) {
    if (provider instanceof ConsoleProvider) {
      out.push(...provider.commands)
    }
  }
  return out
}
