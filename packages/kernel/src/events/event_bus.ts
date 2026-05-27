/**
 * EventBus — the per-Application event dispatcher.
 *
 * **M1.7 scope (this file):** `on`, `once`, `emit` with sequential dispatch in
 * registration order. Errors propagate from `emit`.
 *
 * **M1.9 extends this** with `emitParallel`, `emitNow`, batch `subscribe`,
 * wildcards, and the cancelable-vs-non-cancelable contract from
 * `spec/lifecycles.md`. The M1.7 surface is the minimum the Application
 * needs to emit its lifecycle events (`app:starting`, `app:booted`,
 * `app:shutdown`, `app:terminated`).
 */

import type { Unsubscribe } from '../core/types.ts'

export type Listener<P = unknown> = (payload: P, name?: string) => void | Promise<void>

/** Internal record kept per listener so we can support `.once()` cleanly. */
interface Entry {
  fn: Listener
  once: boolean
}

export class EventBus {
  private listeners = new Map<string, Entry[]>()

  /** Register a listener. Returns an unsubscribe function. */
  on<P = unknown>(name: string, fn: Listener<P>): Unsubscribe {
    return this.addEntry(name, { fn: fn as Listener, once: false })
  }

  /** Register a listener that fires at most once. */
  once<P = unknown>(name: string, fn: Listener<P>): Unsubscribe {
    return this.addEntry(name, { fn: fn as Listener, once: true })
  }

  /**
   * Dispatch a payload to every listener for `name`, sequentially in
   * registration order. Awaits async listeners. Errors propagate from the
   * first throwing listener (M1.9 will refine with the cancelable contract).
   */
  async emit<P = unknown>(name: string, payload?: P): Promise<void> {
    const entries = this.listeners.get(name)
    if (!entries || entries.length === 0) return

    // Snapshot — listeners may unsubscribe or add new ones during dispatch.
    const snapshot = [...entries]

    // Remove `once` listeners before invoking, so re-entrant emits don't refire.
    if (snapshot.some((e) => e.once)) {
      this.listeners.set(
        name,
        entries.filter((e) => !e.once),
      )
    }

    for (const entry of snapshot) {
      await entry.fn(payload as unknown, name)
    }
  }

  /** Remove every listener for a name. */
  removeAllListeners(name?: string): void {
    if (name === undefined) {
      this.listeners.clear()
    } else {
      this.listeners.delete(name)
    }
  }

  /** Count listeners (for diagnostics + tests). */
  listenerCount(name: string): number {
    return this.listeners.get(name)?.length ?? 0
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  private addEntry(name: string, entry: Entry): Unsubscribe {
    let bucket = this.listeners.get(name)
    if (!bucket) {
      bucket = []
      this.listeners.set(name, bucket)
    }
    bucket.push(entry)
    return () => {
      const current = this.listeners.get(name)
      if (!current) return
      const idx = current.indexOf(entry)
      if (idx >= 0) current.splice(idx, 1)
      if (current.length === 0) this.listeners.delete(name)
    }
  }
}
