/**
 * `Broadcaster` — the abstract base that every driver extends and apps
 * inject via the container.
 *
 *   - `publish(channel, event)` — fan-out an event to every subscriber.
 *     Returns once the driver has accepted the publish (for memory:
 *     synchronously; for postgres: after the INSERT commits).
 *   - `subscribe(channel)` — open an `AsyncIterable<BroadcastEvent>`
 *     that yields events until closed via `unsubscribe()` (or by
 *     breaking out of the `for await` loop).
 *   - `authorize(pattern, fn)` — register a per-channel authorization
 *     check. SSE handlers + the notification driver call
 *     `authorizeFor(channel, subject)` before opening a subscription
 *     on behalf of a user.
 *   - `close()` — release driver resources. Optional override; the
 *     `BroadcastProvider.shutdown()` hook calls it.
 *
 * The class is abstract so it serves as the container token —
 * `app.singleton(Broadcaster, factory)` binds the concrete driver,
 * `container.resolve(Broadcaster)` returns it. Same pattern as
 * `Database` / `Logger`.
 *
 * Multi-driver routing is not in scope — broadcast is typically one
 * backplane per app (memory in dev, postgres in prod). Apps that want
 * to mix wire two `Broadcaster` instances behind named tokens.
 */

import {
  type ChannelAuthorizationResult,
  type ChannelAuthorizer,
  ChannelAuthorizerRegistry,
  normalizeAuthorizerResult,
} from './channel_authorizer.ts'
import type { BroadcastEvent, BroadcastSubscription } from './types.ts'

// Non-abstract so the class can be used as a container token —
// `app.singleton(Broadcaster, factory)`. Subclasses MUST override
// `publish` and `subscribe`; the defaults throw to surface forgotten
// overrides during development. Same trade-off as `kernel`'s `Logger`.
export class Broadcaster {
  protected readonly authorizers = new ChannelAuthorizerRegistry()

  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  publish(channel: string, event: BroadcastEvent): Promise<void> {
    throw new Error('Broadcaster.publish must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  subscribe(channel: string): BroadcastSubscription {
    throw new Error('Broadcaster.subscribe must be overridden by the driver subclass.')
  }

  authorize(pattern: string, fn: ChannelAuthorizer): void {
    this.authorizers.register(pattern, fn)
  }

  /**
   * Resolve a registered authorizer against `subject` for `channel`.
   *
   * Default policy when no authorizer matches:
   *   - Channels with the `private-` or `presence-` prefix → denied
   *     (Echo / Pusher convention; opt in by registering an
   *     authorizer for the pattern).
   *   - Everything else → allowed.
   *
   * Returns the structured `ChannelAuthorizationResult` — never
   * throws on denial. Callers (SSE handler, notification driver)
   * branch on `result.authorized`.
   */
  async authorizeFor(channel: string, subject: unknown): Promise<ChannelAuthorizationResult> {
    const matched = this.authorizers.match(channel)
    if (matched !== undefined) {
      return normalizeAuthorizerResult(await matched(channel, subject))
    }
    if (channel.startsWith('private-') || channel.startsWith('presence-')) {
      return { authorized: false }
    }
    return { authorized: true }
  }

  /** Optional resource cleanup. Default implementation is a no-op. */
  async close(): Promise<void> {}
}
