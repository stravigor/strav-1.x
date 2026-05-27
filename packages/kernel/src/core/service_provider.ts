/**
 * Service providers wrap a subsystem's lifecycle:
 *   - `register(app)` — synchronous binding into the container.
 *   - `boot(app)` — async initialization after all providers are registered.
 *   - `shutdown(app)` — reverse-order cleanup on SIGINT/SIGTERM.
 *
 * Providers declare boot-order dependencies by name. The Application performs
 * a topological sort before running `register` and `boot`.
 *
 * @example
 * ```ts
 * class DatabaseProvider extends ServiceProvider {
 *   readonly name = 'database'
 *   readonly dependencies = ['config', 'logger']
 *
 *   register(app: Application): void {
 *     app.singleton(Database, (c) => new Database(c.resolve('config')))
 *   }
 *
 *   async boot(app: Application): Promise<void> {
 *     await app.resolve(Database).connect()
 *   }
 *
 *   async shutdown(app: Application): Promise<void> {
 *     await app.resolve(Database).disconnect()
 *   }
 * }
 * ```
 */

import type { Application } from './application.ts'

export abstract class ServiceProvider {
  /** Unique name used for dependency resolution between providers. */
  abstract readonly name: string

  /** Names of other providers that must be registered and booted first. */
  readonly dependencies: readonly string[] = []

  /**
   * Bind services into the container.
   *
   * Runs synchronously, before any provider's `boot()`. Do NOT call
   * `app.resolve(...)` here — other providers may not have registered yet.
   */
  register(_app: Application): void {}

  /**
   * Initialize services after every provider has called `register()`.
   *
   * May be async. May call `app.resolve(...)` and start background work
   * (open connections, register event listeners, schedule timers).
   */
  boot(_app: Application): void | Promise<void> {}

  /**
   * Clean up resources during shutdown. Called in reverse boot order on
   * SIGINT / SIGTERM or `app.shutdown()`.
   */
  shutdown(_app: Application): void | Promise<void> {}
}
