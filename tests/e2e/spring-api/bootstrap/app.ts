import { Application } from '@strav/kernel'

/**
 * Build the `Application` instance. Providers are NOT attached here —
 * `runCli` (in `bin/strav.ts`) picks the right subset for the requested
 * command from `bootstrap/providers.ts` and registers them on this app.
 *
 * App-level hooks (env detection, custom singletons that don't belong in
 * a provider) can be added here later without touching every command.
 */
export function createApp(): Application {
  return new Application()
}
