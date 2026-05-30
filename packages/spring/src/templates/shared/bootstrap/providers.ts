import { HttpConsoleProvider, HttpProvider } from '@strav/http'
import { ConfigProvider, LoggerProvider, type ServiceProvider } from '@strav/kernel'
import { AppProvider } from '../app/providers/app_provider.ts'
import appConfig from '../config/app.ts'
import httpConfig from '../config/http.ts'
import loggerConfig from '../config/logger.ts'

/**
 * Default provider list. Order is not load-bearing — the container does a
 * dependency-aware topo sort at boot. Keep providers grouped by package
 * for readability.
 *
 * Adding more packages later (database, auth, queue, …)? Install the
 * package, add its config file under `config/`, register its `Config`
 * slot in `ConfigProvider` below, and append the provider to this list.
 */
export function providers(): ServiceProvider[] {
  return [
    new ConfigProvider({
      app: appConfig,
      http: httpConfig,
      logger: loggerConfig,
    }),
    new LoggerProvider(),
    new HttpProvider(),
    new HttpConsoleProvider(),
    new AppProvider(),
  ]
}
