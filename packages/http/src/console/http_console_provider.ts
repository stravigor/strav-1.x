/**
 * `HttpConsoleProvider` — declares the HTTP + server console commands.
 *
 * Apps add it to `bootstrap/providers.ts` alongside `HttpProvider`.
 * `runCli` collects it automatically via `collectCommands()`.
 */

import { ConsoleProvider } from '@strav/cli'
import { All } from './all.ts'
import { Console } from './console.ts'
import { RouteList } from './route_list.ts'
import { Serve } from './serve.ts'

export class HttpConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.http'
  override readonly commands = [Serve, All, RouteList, Console] as const
}
