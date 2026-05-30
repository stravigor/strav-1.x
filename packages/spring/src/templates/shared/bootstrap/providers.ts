import { HttpConsoleProvider, HttpProvider } from '@strav/http'
import { ConfigProvider, LoggerProvider, type ServiceProvider } from '@strav/kernel'
import { AppProvider } from '../app/providers/app_provider.ts'

/**
 * Default provider list. Order is not load-bearing — the container does a
 * dependency-aware topo sort at boot. Keep providers grouped by package
 * for readability.
 *
 * `ConfigProvider.fromDirectory('config')` auto-discovers every
 * `config/*.ts` file and keys them by basename — `config/app.ts` →
 * `config('app.*')`, `config/http.ts` → `config('http.*')`, etc. To add
 * a new config slot, drop a file with a `default export` into
 * `config/`. No edits to this list required.
 */
export async function providers(): Promise<ServiceProvider[]> {
  return [
    await ConfigProvider.fromDirectory('config'),
    new LoggerProvider(),
    new HttpProvider(),
    new HttpConsoleProvider(),
    new AppProvider(),
  ]
}
