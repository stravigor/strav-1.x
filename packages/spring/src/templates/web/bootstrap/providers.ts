import { HttpConsoleProvider, HttpProvider } from '@strav/http'
import { ConfigProvider, LoggerProvider, type ServiceProvider } from '@strav/kernel'
import { ViewConsoleProvider, ViewProvider } from '@strav/view'
import { AppProvider } from '../app/providers/app_provider.ts'
import appConfig from '../config/app.ts'
import httpConfig from '../config/http.ts'
import loggerConfig from '../config/logger.ts'
import viewConfig from '../config/view.ts'

/**
 * Default provider list. Order is not load-bearing — the container does a
 * dependency-aware topo sort at boot. Keep providers grouped by package
 * for readability.
 *
 * `ViewProvider` discovers `.strav` files under `resources/views/pages/`
 * and registers a route for each at boot. `ViewConsoleProvider` adds the
 * `view:build` / `view:cache` / `view:clear` commands.
 */
export function providers(): ServiceProvider[] {
  return [
    new ConfigProvider({
      app: appConfig,
      http: httpConfig,
      logger: loggerConfig,
      view: viewConfig,
    }),
    new LoggerProvider(),
    new HttpProvider(),
    new HttpConsoleProvider(),
    new ViewProvider(),
    new ViewConsoleProvider(),
    new AppProvider(),
  ]
}
