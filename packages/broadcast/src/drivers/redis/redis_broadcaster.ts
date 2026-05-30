/**
 * `RedisBroadcaster` — multi-node broadcast backplane via Redis Pub/Sub.
 *
 * Why Redis (vs the Postgres ledger):
 *
 *   - End-to-end latency is one network hop — no polling floor.
 *   - The Postgres driver is fine up to a few hundred messages/sec on
 *     small clusters; once subscribers fan out wider or publish rates
 *     climb, Redis is the obvious next step. Apps deploying behind a
 *     reverse proxy with sticky sessions and a small node count can
 *     stay on Postgres; everyone else picks this.
 *
 * How it works:
 *
 *   - Two Bun `RedisClient` instances — one for publish, one for
 *     subscribe. Bun's client enters a sticky pub/sub mode after
 *     `subscribe(...)`, blocking most other commands until
 *     `unsubscribe()`. The split keeps publishes from being gated on
 *     the subscribe-mode lock.
 *   - `publish(channel, event)` JSON-encodes the event and calls
 *     `pub.publish(channel, payload)`.
 *   - `subscribe(channel)` opens a local subscription via an embedded
 *     `MemoryBroadcaster` and, on the first subscriber for a channel,
 *     issues a single `sub.subscribe(channel, listener)` upstream. The
 *     listener decodes the JSON payload and fans it out locally. When
 *     the last subscriber for a channel goes away, the upstream
 *     subscription is released via `sub.unsubscribe(channel)`.
 *   - Subscribers always start from "events published from now on" —
 *     same contract as `PostgresBroadcaster`. Apps that need replay
 *     wire a separate ledger (the Postgres driver, or a custom
 *     stream-backed one).
 *
 * Both `RedisBroadcastProvider` and `BroadcastProvider` register under
 * the same `Broadcaster` token, so app code injecting `Broadcaster`
 * doesn't change between drivers.
 */

import { BroadcastPublishError } from '../../broadcast_error.ts'
import { Broadcaster } from '../../broadcaster.ts'
import type { BroadcastEvent, BroadcastSubscription } from '../../types.ts'
import { MemoryBroadcaster } from '../memory/memory_broadcaster.ts'

/**
 * Minimal slice of `Bun.RedisClient` the broadcaster actually uses.
 * Declared inline so a custom client can be injected for tests without
 * standing up a real Redis.
 */
export interface RedisBroadcasterClient {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<number>
  unsubscribe(channel: string): Promise<void>
  close(): void
}

export interface RedisBroadcasterOptions {
  /**
   * Redis connection URL — `redis://host:port` or `rediss://…` for TLS.
   * Required unless `pub` and `sub` are both injected directly.
   */
  url?: string
  /** Custom publisher client — usually only set in tests. */
  pub?: RedisBroadcasterClient
  /** Custom subscriber client — usually only set in tests. */
  sub?: RedisBroadcasterClient
  /**
   * Per-subscription buffer cap forwarded to the in-process
   * `MemoryBroadcaster`. Default `1000`.
   */
  maxBufferSize?: number
  /** Forwarded to the in-process `MemoryBroadcaster`'s onOverflow hook. */
  onOverflow?: (channel: string, droppedEvent: BroadcastEvent) => void
}

export class RedisBroadcaster extends Broadcaster {
  private readonly pub: RedisBroadcasterClient
  private readonly sub: RedisBroadcasterClient
  private readonly ownsClients: boolean
  private readonly local: MemoryBroadcaster
  private readonly upstream = new Map<string, Promise<void>>()
  private readonly subscribed = new Set<string>()
  private closed = false

  constructor(options: RedisBroadcasterOptions) {
    super()
    if (options.pub !== undefined || options.sub !== undefined) {
      if (options.pub === undefined || options.sub === undefined) {
        throw new Error(
          'RedisBroadcaster: when injecting clients, both `pub` and `sub` must be provided.',
        )
      }
      this.pub = options.pub
      this.sub = options.sub
      this.ownsClients = false
    } else {
      if (options.url === undefined || options.url === '') {
        throw new Error(
          'RedisBroadcaster: `url` is required (e.g. `redis://127.0.0.1:6379`) unless `pub`/`sub` are injected.',
        )
      }
      // Deferred import — keeps `bun` off the lookup path when callers
      // inject their own clients (e.g. tests). The runtime import
      // resolves to Bun's built-in `RedisClient`.
      // biome-ignore lint/suspicious/noExplicitAny: Bun global types vary by version
      const { RedisClient } = require('bun') as { RedisClient: new (url: string) => any }
      this.pub = new RedisClient(options.url) as RedisBroadcasterClient
      this.sub = new RedisClient(options.url) as RedisBroadcasterClient
      this.ownsClients = true
    }
    this.local = new MemoryBroadcaster({
      ...(options.maxBufferSize !== undefined ? { maxBufferSize: options.maxBufferSize } : {}),
      ...(options.onOverflow !== undefined ? { onOverflow: options.onOverflow } : {}),
    })
  }

  override async publish(channel: string, event: BroadcastEvent): Promise<void> {
    let payload: string
    try {
      payload = JSON.stringify(event)
    } catch (cause) {
      throw new BroadcastPublishError('RedisBroadcaster: event is not JSON-serialisable.', {
        context: { channel, event: event.event },
        cause,
      })
    }
    try {
      await this.pub.publish(channel, payload)
    } catch (cause) {
      throw new BroadcastPublishError('RedisBroadcaster: PUBLISH failed.', {
        context: { channel, event: event.event },
        cause,
      })
    }
  }

  override subscribe(channel: string): BroadcastSubscription {
    const localSub = this.local.subscribe(channel)
    void this.ensureUpstream(channel)

    const dropIfLast = async (): Promise<void> => {
      if (this.closed) return
      if (this.local.subscriberCount(channel) > 0) return
      if (!this.subscribed.has(channel)) return
      this.subscribed.delete(channel)
      this.upstream.delete(channel)
      try {
        await this.sub.unsubscribe(channel)
      } catch {
        // Best-effort — a transient client error here shouldn't break
        // consumers. The next subscribe() re-issues the upstream call.
      }
    }

    const wrapped: BroadcastSubscription = {
      [Symbol.asyncIterator](): AsyncIterableIterator<BroadcastEvent> {
        return wrapped
      },
      next: () => localSub.next(),
      async return(): Promise<IteratorResult<BroadcastEvent>> {
        const result = await (localSub.return?.() ??
          Promise.resolve({ value: undefined, done: true as const }))
        await dropIfLast()
        return result
      },
      async unsubscribe(): Promise<void> {
        await localSub.unsubscribe()
        await dropIfLast()
      },
    }
    return wrapped
  }

  override async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const channel of this.subscribed) {
      try {
        await this.sub.unsubscribe(channel)
      } catch {
        // Same rationale as dropIfLast — best-effort cleanup.
      }
    }
    this.subscribed.clear()
    this.upstream.clear()
    await this.local.close()
    if (this.ownsClients) {
      try {
        this.pub.close()
      } catch {
        // Already closed or never connected.
      }
      try {
        this.sub.close()
      } catch {
        // Same.
      }
    }
  }

  /** @internal — diagnostics for tests. */
  upstreamSubscribed(channel: string): boolean {
    return this.subscribed.has(channel)
  }

  private async ensureUpstream(channel: string): Promise<void> {
    if (this.closed) return
    const existing = this.upstream.get(channel)
    if (existing !== undefined) return existing
    const promise = (async (): Promise<void> => {
      await this.sub.subscribe(channel, (message: string, ch: string) => {
        if (this.closed) return
        let event: BroadcastEvent
        try {
          event = JSON.parse(message) as BroadcastEvent
        } catch {
          // Non-JSON traffic on a Strav channel is most likely a third
          // party sharing the Redis instance. Drop silently rather
          // than dying — apps that care wire a Redis client themselves.
          return
        }
        void this.local.publish(ch, event)
      })
      this.subscribed.add(channel)
    })()
    this.upstream.set(channel, promise)
    try {
      await promise
    } catch {
      // Subscribe failure: clear so the next subscribe() retries. The
      // local subscription is still live; it just won't receive events
      // until upstream is healthy.
      this.upstream.delete(channel)
    }
  }
}
