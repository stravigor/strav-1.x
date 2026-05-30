/**
 * `MemoryBroadcaster` — in-process pub/sub.
 *
 * Subscribers register a per-channel buffer; `publish` walks the
 * buffer list, pushes the event onto each, and resolves any pending
 * `next()` awaiters. Backpressure is bounded — buffers cap at
 * `maxBufferSize` (default 1000), and the oldest event is dropped
 * when the cap is hit. Apps that need stricter backpressure register
 * an `onOverflow` handler at construction time.
 *
 * Single-process only. Apps deploying more than one node use
 * `PostgresBroadcaster` (or write their own driver against Redis /
 * NATS / etc.).
 */

import { Broadcaster } from '../../broadcaster.ts'
import type { BroadcastEvent, BroadcastSubscription } from '../../types.ts'

export interface MemoryBroadcasterOptions {
  /**
   * Maximum events buffered per subscription before the oldest is
   * dropped. Tune higher if subscribers can pause for long stretches;
   * tune lower to surface back-pressure faster. Default `1000`.
   */
  maxBufferSize?: number
  /**
   * Called when a subscription's buffer overflows and an event is
   * dropped. Apps wire telemetry / metrics here. Default: silent.
   */
  onOverflow?: (channel: string, droppedEvent: BroadcastEvent) => void
}

interface MemorySubscriberState {
  channel: string
  buffer: BroadcastEvent[]
  /** Resolves the consumer's pending `next()` call, if any. */
  pendingResolve: ((result: IteratorResult<BroadcastEvent>) => void) | undefined
  closed: boolean
}

export class MemoryBroadcaster extends Broadcaster {
  private readonly subscribers = new Map<string, Set<MemorySubscriberState>>()
  private readonly maxBufferSize: number
  private readonly onOverflow: ((channel: string, event: BroadcastEvent) => void) | undefined

  constructor(options: MemoryBroadcasterOptions = {}) {
    super()
    this.maxBufferSize = options.maxBufferSize ?? 1000
    this.onOverflow = options.onOverflow
  }

  override async publish(channel: string, event: BroadcastEvent): Promise<void> {
    const set = this.subscribers.get(channel)
    if (set === undefined) return
    for (const sub of set) {
      this.deliver(sub, event)
    }
  }

  override subscribe(channel: string): BroadcastSubscription {
    const state: MemorySubscriberState = {
      channel,
      buffer: [],
      pendingResolve: undefined,
      closed: false,
    }
    let set = this.subscribers.get(channel)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(channel, set)
    }
    set.add(state)

    const detach = (): void => {
      if (state.closed) return
      state.closed = true
      const s = this.subscribers.get(channel)
      if (s !== undefined) {
        s.delete(state)
        if (s.size === 0) this.subscribers.delete(channel)
      }
      if (state.pendingResolve !== undefined) {
        const resolve = state.pendingResolve
        state.pendingResolve = undefined
        resolve({ value: undefined, done: true })
      }
    }

    const subscription: BroadcastSubscription = {
      [Symbol.asyncIterator](): AsyncIterableIterator<BroadcastEvent> {
        return subscription
      },
      async next(): Promise<IteratorResult<BroadcastEvent>> {
        if (state.closed && state.buffer.length === 0) {
          return { value: undefined, done: true }
        }
        const buffered = state.buffer.shift()
        if (buffered !== undefined) return { value: buffered, done: false }
        return new Promise<IteratorResult<BroadcastEvent>>((resolve) => {
          state.pendingResolve = resolve
        })
      },
      async return(): Promise<IteratorResult<BroadcastEvent>> {
        detach()
        return { value: undefined, done: true }
      },
      async unsubscribe(): Promise<void> {
        detach()
      },
    }
    return subscription
  }

  override async close(): Promise<void> {
    for (const set of this.subscribers.values()) {
      for (const sub of set) {
        sub.closed = true
        if (sub.pendingResolve !== undefined) {
          const resolve = sub.pendingResolve
          sub.pendingResolve = undefined
          resolve({ value: undefined, done: true })
        }
      }
    }
    this.subscribers.clear()
  }

  /** Snapshot of subscriber count per channel — diagnostics / tests. */
  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0
  }

  private deliver(state: MemorySubscriberState, event: BroadcastEvent): void {
    if (state.closed) return
    // Fast path — consumer is waiting on next().
    if (state.pendingResolve !== undefined) {
      const resolve = state.pendingResolve
      state.pendingResolve = undefined
      resolve({ value: event, done: false })
      return
    }
    // Slow path — buffer + cap.
    if (state.buffer.length >= this.maxBufferSize) {
      const dropped = state.buffer.shift()
      if (dropped !== undefined && this.onOverflow !== undefined) {
        this.onOverflow(state.channel, dropped)
      }
    }
    state.buffer.push(event)
  }
}
