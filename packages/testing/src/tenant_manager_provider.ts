/**
 * Standard `TenantManager` wiring for tests.
 *
 * `DatabaseProvider` doesn't auto-register `TenantManager` — apps wire
 * it themselves so the binding is explicit (and so apps that don't use
 * tenancy don't pay for it). Every integration / e2e suite that uses
 * `TenantManager` defined an identical 3-line `ServiceProvider` to do
 * the wiring; this is the extracted version.
 *
 * ```ts
 * import { TenantManagerProvider } from '@strav/testing'
 *
 * app.useProviders([
 *   new ConfigProvider({ ... }),
 *   new LoggerProvider(),
 *   new DatabaseProvider(),
 *   new TenantManagerProvider(),
 *   // your provider here
 * ])
 * ```
 *
 * The class implements the same shape every e2e was rolling by hand:
 * declares `database` as a dependency, binds `TenantManager` as a
 * singleton built from the resolved `PostgresDatabase` + `EventBus`.
 */

import { PostgresDatabase, TenantManager } from '@strav/database'
import { type Application, EventBus, ServiceProvider } from '@strav/kernel'

export class TenantManagerProvider extends ServiceProvider {
  override readonly name = 'tenant'
  override readonly dependencies = ['database']

  override register(app: Application): void {
    app.singleton(
      TenantManager,
      (c) => new TenantManager(c.resolve(PostgresDatabase), c.resolve(EventBus)),
    )
  }
}
