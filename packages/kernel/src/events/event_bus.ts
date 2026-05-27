/**
 * EventBus — the per-Application event dispatcher.
 *
 * Implements the multi-listener contract from `spec/lifecycles.md`:
 *
 * - **Order**: registration FIFO across the whole bus (wildcards interleave
 *   with specific listeners; there is one ordered dispatch list, not two).
 * - **Execution**: `emit` runs listeners sequentially and awaits each. Total
 *   `emit` time = sum of listener durations.
 * - **Errors in non-cancelable events**: caught, reported via the configured
 *   error handler (default `console.error`), remaining listeners still run.
 * - **Errors in cancelable events** (`*.creating`, `*.updating`, `*.deleting`,
 *   `*.restoring` by default): first throw wins, chain stops, `emit` rejects.
 * - **Parallel mode** (`emitParallel`): `Promise.allSettled`-style, aggregated
 *   failures. **Not allowed on cancelable events** — throws at call time.
 * - **Wildcards**: `*` matches every event; `prefix.*` matches one dot-segment
 *   after `prefix.`. Multi-level wildcards are not supported in 1.0.
 * - **Batch registration**: `on` and `subscribe` accept arrays / maps.
 * - **Listener shapes**: plain function, `@inject()`-decorated class with
 *   `handle()`, or instance with `handle()`. Auto-detected.
 */

import { isInjectable } from '../core/inject.ts'
import type { Constructor, Unsubscribe } from '../core/types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Plain function listener. */
export type Listener<P = unknown> = (payload: P, name?: string) => void | Promise<void>

/** Class listener — class with `handle(payload, name?)`. */
export type ListenerClass<P = unknown> = new (
  // biome-ignore lint/suspicious/noExplicitAny: constructor params shape is unknown
  ...args: any[]
) => ListenerInstance<P>

/** Instance listener — object with `handle(payload, name?)`. */
export interface ListenerInstance<P = unknown> {
  handle(payload: P, name?: string): void | Promise<void>
}

/** Any of the listener shapes accepted by `on` / `once` / `subscribe`. */
export type AnyListener<P = unknown> = Listener<P> | ListenerClass<P> | ListenerInstance<P>

/** Construction-time options for the bus. */
export interface EventBusOptions {
  /**
   * Resolver used to construct class-listeners via the IoC container. The
   * Application passes a closure over `this.make` here. Without a resolver,
   * registering a class-listener throws on dispatch.
   */
  resolver?: <T>(Class: Constructor<T>) => T

  /**
   * Predicate that decides whether an event name is cancelable. Cancelable
   * events propagate the first listener throw and stop further dispatch.
   * Default: matches the suffixes `.creating`, `.updating`, `.deleting`,
   * `.restoring` (the repository lifecycle gates).
   */
  isCancelable?: (name: string) => boolean

  /**
   * Handler invoked when a listener throws on a non-cancelable event. Default
   * `console.error`. The Application can route this through its
   * `ExceptionHandler` when M1.10 lands.
   */
  onListenerError?: (error: unknown, eventName: string) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Default cancelable predicate — repository lifecycle gates. */
const DEFAULT_CANCELABLE = /\.(creating|updating|deleting|restoring)$/

interface Entry {
  /** Registered pattern: exact name (`'user.created'`) or wildcard (`'user.*'`, `'*'`). */
  pattern: string
  /** Resolved callable. Already wraps class / instance / function listeners uniformly. */
  fn: Listener
  /** One-shot listener? */
  once: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// EventBus
// ─────────────────────────────────────────────────────────────────────────────

export class EventBus {
  /**
   * Single ordered list of entries. Preserves registration FIFO across exact
   * and wildcard listeners — matters because the spec requires order to be
   * stable across both kinds.
   */
  private entries: Entry[] = []

  private readonly resolver?: <T>(Class: Constructor<T>) => T
  private readonly isCancelable: (name: string) => boolean
  private onListenerError: (error: unknown, eventName: string) => void

  constructor(opts: EventBusOptions = {}) {
    this.resolver = opts.resolver
    this.isCancelable = opts.isCancelable ?? ((name) => DEFAULT_CANCELABLE.test(name))
    this.onListenerError =
      opts.onListenerError ??
      ((error, eventName) => {
        console.error(`EventBus: listener for "${eventName}" threw:`, error)
      })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Registration
  // ───────────────────────────────────────────────────────────────────────────

  /** Register a listener. Returns an unsubscribe function. */
  on<P = unknown>(name: string, listener: AnyListener<P>): Unsubscribe
  /** Register multiple listeners against one event. */
  on<P = unknown>(name: string, listeners: AnyListener<P>[]): Unsubscribe
  /** Register one listener against multiple events. */
  on<P = unknown>(names: string[], listener: AnyListener<P>): Unsubscribe
  /** Cross-product: every listener to every event. */
  on<P = unknown>(names: string[], listeners: AnyListener<P>[]): Unsubscribe
  on<P = unknown>(
    nameOrNames: string | string[],
    listenerOrListeners: AnyListener<P> | AnyListener<P>[],
  ): Unsubscribe {
    return this.bulkRegister(nameOrNames, listenerOrListeners, false)
  }

  /** Register a listener that fires at most once. Single-form only. */
  once<P = unknown>(name: string, listener: AnyListener<P>): Unsubscribe {
    return this.bulkRegister(name, listener, true)
  }

  /**
   * Subscription map. Keys are event names (exact or wildcard); values are a
   * listener or array of listeners. Returns ONE unsubscribe that removes
   * every registration made by the call.
   */
  subscribe(map: Record<string, AnyListener | AnyListener[]>): Unsubscribe {
    const offs: Unsubscribe[] = []
    for (const [name, listenerOrListeners] of Object.entries(map)) {
      offs.push(this.bulkRegister(name, listenerOrListeners, false))
    }
    return () => {
      for (const off of offs) off()
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Emission
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Dispatch a payload to every matching listener, **sequentially** in
   * registration order. Awaits each before invoking the next.
   *
   * Cancelable events: first listener throw rejects `emit`, subsequent
   * listeners do NOT run.
   *
   * Non-cancelable events: listener throws are caught + reported, remaining
   * listeners still run, `emit` resolves successfully.
   */
  async emit<P = unknown>(name: string, payload?: P): Promise<void> {
    const matched = this.matching(name)
    if (matched.length === 0) return

    this.prepareForDispatch(matched)
    const cancelable = this.isCancelable(name)

    for (const entry of matched) {
      try {
        await entry.fn(payload as unknown, name)
      } catch (error) {
        if (cancelable) throw error
        this.onListenerError(error, name)
      }
    }
  }

  /**
   * Dispatch concurrently — `Promise.allSettled`-style. **Not allowed on
   * cancelable events** (they require ordering to gate); throws synchronously
   * if you try.
   *
   * Resolves when every listener has settled. If at least one listener fails,
   * an `AggregateError` is thrown that collects every failure. (Successful
   * listeners do not prevent the failures from being raised — caller can
   * decide what to do.)
   */
  async emitParallel<P = unknown>(name: string, payload?: P): Promise<void> {
    if (this.isCancelable(name)) {
      throw new Error(
        `EventBus: cannot emitParallel on cancelable event "${name}". ` +
          `Cancellation requires sequential ordering. Use emit() instead.`,
      )
    }

    const matched = this.matching(name)
    if (matched.length === 0) return

    this.prepareForDispatch(matched)

    // Wrap in `async` so synchronous throws become rejected promises rather
    // than throwing out of `.map` and skipping `Promise.allSettled`.
    const results = await Promise.allSettled(
      matched.map(async (entry) => entry.fn(payload as unknown, name)),
    )

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason)
    if (errors.length === 0) return

    if (errors.length === results.length) {
      // All failed — surface as AggregateError so callers see every failure.
      throw new AggregateError(
        errors,
        `EventBus: all ${errors.length} listeners failed for "${name}".`,
      )
    }
    // Partial failure — report each error individually but resolve.
    for (const error of errors) this.onListenerError(error, name)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Diagnostics
  // ───────────────────────────────────────────────────────────────────────────

  /** Remove every listener for a name, or every listener everywhere. */
  removeAllListeners(name?: string): void {
    if (name === undefined) {
      this.entries = []
      return
    }
    this.entries = this.entries.filter((e) => e.pattern !== name)
  }

  /**
   * Count listeners registered under an exact pattern. Wildcard listeners
   * registered under e.g. `user.*` are counted under that pattern, not under
   * `user.created`. Use only for diagnostics.
   */
  listenerCount(pattern: string): number {
    return this.entries.reduce((acc, e) => (e.pattern === pattern ? acc + 1 : acc), 0)
  }

  /** Replace the error handler (used when ExceptionHandler lands in M1.10). */
  setErrorHandler(handler: (error: unknown, eventName: string) => void): void {
    this.onListenerError = handler
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals — registration
  // ───────────────────────────────────────────────────────────────────────────

  private bulkRegister<P>(
    nameOrNames: string | string[],
    listenerOrListeners: AnyListener<P> | AnyListener<P>[],
    once: boolean,
  ): Unsubscribe {
    const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames]
    const listeners = Array.isArray(listenerOrListeners)
      ? listenerOrListeners
      : [listenerOrListeners]

    const created: Entry[] = []
    for (const name of names) {
      for (const listener of listeners) {
        const entry: Entry = {
          pattern: name,
          fn: this.resolveListener(listener),
          once,
        }
        this.entries.push(entry)
        created.push(entry)
      }
    }

    return () => {
      for (const entry of created) {
        const i = this.entries.indexOf(entry)
        if (i >= 0) this.entries.splice(i, 1)
      }
    }
  }

  /**
   * Coerce a listener of any shape into a uniform `Listener` callable.
   *
   * Detection:
   *   - object with a `.handle` function → instance listener.
   *   - function with `.prototype.handle` OR marked `@inject()` → class
   *     listener (resolved via the container resolver on each dispatch).
   *   - any other function → plain listener.
   */
  private resolveListener<P>(listener: AnyListener<P>): Listener {
    // Instance with .handle
    if (
      typeof listener === 'object' &&
      listener !== null &&
      typeof (listener as ListenerInstance<P>).handle === 'function'
    ) {
      const instance = listener as ListenerInstance<P>
      return (payload, name) => instance.handle(payload as P, name)
    }

    if (typeof listener !== 'function') {
      throw new Error(
        'EventBus: listener must be a function, a class with .handle(), or an object with .handle().',
      )
    }

    // Class with .handle on the prototype, or @inject()-marked
    if (this.looksLikeClass(listener)) {
      const Class = listener as ListenerClass<P>
      const proto = (Class as unknown as { prototype?: { handle?: unknown } }).prototype
      if (proto && typeof proto.handle !== 'function') {
        throw new Error(
          `EventBus: class listener ${(Class as { name: string }).name} has no .handle() method. ` +
            'Add `handle(payload, name?)` or pass a plain function.',
        )
      }
      return async (payload, name) => {
        if (!this.resolver) {
          throw new Error(
            `EventBus: cannot construct class listener ${(Class as { name: string }).name} — ` +
              'no container resolver configured. Construct EventBus with `{ resolver }`, ' +
              'or attach a plain function listener.',
          )
        }
        const instance = this.resolver(Class as unknown as Constructor) as ListenerInstance<P>
        return instance.handle(payload as P, name)
      }
    }

    // Plain function
    return listener as Listener
  }

  // biome-ignore lint/suspicious/noExplicitAny: heuristic on bare functions
  private looksLikeClass(fn: any): boolean {
    if (isInjectable(fn)) return true
    const proto = fn?.prototype as Record<string, unknown> | undefined
    if (proto && typeof proto === 'object' && typeof proto.handle === 'function') return true
    const src = Function.prototype.toString.call(fn)
    return src.startsWith('class ') || src.startsWith('class{')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals — dispatch
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Snapshot matching entries before dispatch. Listeners added DURING dispatch
   * must not fire for this emission, per the spec's snapshot contract.
   */
  private matching(name: string): Entry[] {
    const out: Entry[] = []
    for (const entry of this.entries) {
      if (this.patternMatches(entry.pattern, name)) out.push(entry)
    }
    return out
  }

  /**
   * Remove `once` entries from the active list **before** their handlers run.
   * Prevents re-entrant emits from re-firing the same once-listener.
   */
  private prepareForDispatch(matched: Entry[]): void {
    if (!matched.some((e) => e.once)) return
    this.entries = this.entries.filter((e) => !matched.includes(e) || !e.once)
  }

  /**
   * Wildcard match rules (spec §"Wildcards" in `guides/19-events.md`):
   *   - exact equality wins for non-wildcard patterns.
   *   - `*` matches every event (any number of dot-segments).
   *   - `prefix.*` matches `prefix.<one segment>`. No multi-level wildcards.
   *   - `:` (lifecycle separator) is treated as a regular character.
   */
  private patternMatches(pattern: string, eventName: string): boolean {
    if (pattern === eventName) return true
    if (pattern === '*') return true
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2)
      if (!eventName.startsWith(`${prefix}.`)) return false
      const rest = eventName.slice(prefix.length + 1)
      return rest.length > 0 && !rest.includes('.')
    }
    return false
  }
}
