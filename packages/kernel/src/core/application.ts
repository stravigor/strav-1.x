/**
 * `Application` is a `Container` plus provider orchestration:
 *   - Topologically sorts registered providers by `dependencies`.
 *   - Calls `register()` synchronously on every provider in order.
 *   - Calls `boot()` async-sequentially in order; rolls back on failure.
 *   - Installs SIGINT/SIGTERM handlers (suppressible).
 *   - Owns an `EventBus` (`app.events`) that emits lifecycle events.
 *   - Exposes runtime-env helpers (`env`, `isProduction`, …).
 *
 * @see docs/kernel/api.md
 * @see spec/lifecycles.md
 */

import { EventBus } from '../events/event_bus.ts'
import { Container } from './container.ts'
import type { ServiceProvider } from './service_provider.ts'
import type { Constructor } from './types.ts'

/** How long shutdown is allowed to take before the process is force-exited. */
const SHUTDOWN_TIMEOUT_MS = 30_000

/** Runtime environment values. */
export type AppEnv = 'local' | 'testing' | 'staging' | 'production'

/** Options for `app.start(...)`. */
export interface StartOptions {
  /**
   * Whether to install SIGINT/SIGTERM handlers. Default `true`.
   * Queue workers and tests typically pass `false` to manage signals themselves.
   */
  signalHandlers?: boolean
}

export class Application extends Container {
  /**
   * Per-application event bus. Survives until the app is fully shut down.
   *
   * The bus is constructed with a resolver bound to `this.make` so class
   * listeners are auto-constructed via the container on each dispatch. See
   * `docs/kernel/guides/events.md`.
   */
  readonly events: EventBus = new EventBus({
    resolver: <T>(Class: Constructor<T>): T => this.make(Class),
  })

  private _providers: ServiceProvider[] = []
  private _bootedProviders: ServiceProvider[] = []
  private _booted = false
  private _shuttingDown = false
  private _signalHandlers: Array<{ signal: NodeJS.Signals; handler: NodeJS.SignalsListener }> = []

  /** Whether the application has finished booting. */
  get isBooted(): boolean {
    return this._booted
  }

  /** Whether the application is currently shutting down. */
  get isShuttingDown(): boolean {
    return this._shuttingDown
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Provider registration
  // ───────────────────────────────────────────────────────────────────────────

  /** Add one provider. Must be called before `start()`. */
  use(provider: ServiceProvider): this {
    if (this._booted) {
      throw new Error(
        `Application: cannot add provider "${provider.name}" after the application has started.`,
      )
    }
    this._providers.push(provider)
    return this
  }

  /** Add several providers at once. Must be called before `start()`. */
  useProviders(providers: ServiceProvider[]): this {
    if (this._booted) {
      throw new Error('Application: cannot add providers after the application has started.')
    }
    this._providers.push(...providers)
    return this
  }

  /** Convenience: subscribe to `app:booted` and return `this`. */
  onBooted(callback: () => void | Promise<void>): this {
    this.events.once('app:booted', callback)
    return this
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Boot the application.
   *
   * Sequence:
   *   1. emit `app:starting`
   *   2. topo-sort providers by `dependencies`
   *   3. call `register(app)` on every provider (sync)
   *   4. call `boot(app)` on every provider (async, in order)
   *   5. install SIGINT/SIGTERM handlers (unless `signalHandlers: false`)
   *   6. emit `app:booted`
   *
   * On boot failure: shut down any already-booted providers in reverse order,
   * then re-throw the original error.
   */
  async start(options?: StartOptions): Promise<void> {
    if (this._booted) return

    await this.events.emit('app:starting')

    const sorted = this.topologicalSort(this._providers)

    // Phase 1 — synchronous register pass.
    for (const provider of sorted) {
      provider.register(this)
    }

    // Phase 2 — async boot pass with rollback on failure.
    for (const provider of sorted) {
      try {
        await provider.boot(this)
        this._bootedProviders.push(provider)
      } catch (error) {
        await this.shutdownProviders()
        throw error
      }
    }

    this._booted = true
    if (options?.signalHandlers !== false) {
      this.installSignalHandlers()
    }

    await this.events.emit('app:booted')
  }

  /**
   * Gracefully shut down the application.
   *
   * Calls `shutdown()` on every booted provider in reverse boot order. A
   * {@link SHUTDOWN_TIMEOUT_MS}-second timeout force-exits the process if a
   * provider hangs. Errors in individual `shutdown()` calls are caught and
   * logged so one bad provider doesn't block the rest.
   */
  async shutdown(): Promise<void> {
    if (this._shuttingDown) return
    this._shuttingDown = true

    await this.events.emit('app:shutdown')

    const timer = setTimeout(() => {
      console.error(`Application: shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit.`)
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref()

    try {
      await this.shutdownProviders()
    } finally {
      clearTimeout(timer)
      this.removeSignalHandlers()
      this._booted = false
      this.dispose()
    }

    await this.events.emit('app:terminated')
    this._shuttingDown = false
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Runtime environment helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Current `APP_ENV`. Defaults to `'production'` (safe default for an unset
   * env). When `ConfigRepository` lands in M1.8, this delegates to the config.
   */
  env(): AppEnv
  env(check: AppEnv): boolean
  env(check?: AppEnv): AppEnv | boolean {
    const current = (process.env.APP_ENV ?? 'production') as AppEnv
    if (check === undefined) return current
    return current === check
  }

  isProduction(): boolean {
    return this.env() === 'production'
  }

  isLocal(): boolean {
    return this.env() === 'local'
  }

  isTesting(): boolean {
    return this.env() === 'testing'
  }

  isStaging(): boolean {
    return this.env() === 'staging'
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Shut down already-booted providers in reverse boot order. Per-provider
   * errors are caught and logged so the shutdown loop continues.
   */
  private async shutdownProviders(): Promise<void> {
    const reversed = [...this._bootedProviders].reverse()
    for (const provider of reversed) {
      try {
        await provider.shutdown(this)
      } catch (error) {
        console.error(`Application: error in shutdown of provider "${provider.name}":`, error)
      }
    }
    this._bootedProviders = []
  }

  private installSignalHandlers(): void {
    const handler: NodeJS.SignalsListener = () => {
      this.shutdown()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error('Application: shutdown error:', error)
          process.exit(1)
        })
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, handler)
      this._signalHandlers.push({ signal, handler })
    }
  }

  private removeSignalHandlers(): void {
    for (const { signal, handler } of this._signalHandlers) {
      process.off(signal, handler)
    }
    this._signalHandlers = []
  }

  /**
   * Topological sort via Kahn's algorithm.
   *
   * Throws on:
   *   - Duplicate provider name.
   *   - Dependency on an unregistered provider name.
   *   - Cycle in the dependency graph.
   */
  private topologicalSort(providers: ServiceProvider[]): ServiceProvider[] {
    const byName = new Map<string, ServiceProvider>()
    for (const p of providers) {
      if (byName.has(p.name)) {
        throw new Error(`Application: duplicate provider name "${p.name}".`)
      }
      byName.set(p.name, p)
    }

    const inDegree = new Map<string, number>()
    const dependents = new Map<string, string[]>()

    for (const p of providers) {
      inDegree.set(p.name, 0)
      dependents.set(p.name, [])
    }

    for (const p of providers) {
      for (const dep of p.dependencies) {
        if (!byName.has(dep)) {
          throw new Error(
            `Application: provider "${p.name}" depends on "${dep}", which is not registered.`,
          )
        }
        inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1)
        // biome-ignore lint/style/noNonNullAssertion: dependents map is pre-seeded above
        dependents.get(dep)!.push(p.name)
      }
    }

    const queue: string[] = []
    for (const [name, degree] of inDegree) {
      if (degree === 0) queue.push(name)
    }

    const sorted: ServiceProvider[] = []
    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: queue length checked above
      const name = queue.shift()!
      // biome-ignore lint/style/noNonNullAssertion: name came from byName above
      sorted.push(byName.get(name)!)

      // biome-ignore lint/style/noNonNullAssertion: dependents map pre-seeded
      for (const dependent of dependents.get(name)!) {
        // biome-ignore lint/style/noNonNullAssertion: inDegree map pre-seeded
        const newDegree = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDegree)
        if (newDegree === 0) queue.push(dependent)
      }
    }

    if (sorted.length !== providers.length) {
      const remaining = providers.filter((p) => !sorted.includes(p)).map((p) => p.name)
      throw new Error(`Application: circular dependency among providers — ${remaining.join(' → ')}`)
    }

    return sorted
  }
}
