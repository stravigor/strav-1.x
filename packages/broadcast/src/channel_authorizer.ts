/**
 * Per-channel authorization.
 *
 * A `ChannelAuthorizer` decides whether a subject — typically the
 * authenticated user, but any opaque value works — may subscribe to a
 * named channel. Authorizers are matched literally first, then by
 * pattern (`presence-room-*`); the first match wins. The default
 * policy when no authorizer is registered is open / public (matching
 * the in-process broadcast semantics — there's no auth across SSE
 * connections by default; apps opt in).
 *
 * The function may return either a boolean (allowed?) or a richer
 * `ChannelAuthorizationResult` carrying presence metadata that the
 * caller (typically the SSE handler) embeds in the initial event
 * stream. This mirrors Laravel Echo / Pusher conventions.
 */

export interface ChannelAuthorizationResult {
  authorized: boolean
  /**
   * Optional structured metadata about the subject — surfaces on
   * presence channels (e.g. `{ id: 'u_1', name: 'Alice' }`). The
   * caller decides what to do with it; broadcasters themselves treat
   * it as opaque.
   */
  presence?: Record<string, unknown>
}

export type ChannelAuthorizer = (
  channel: string,
  subject: unknown,
) => boolean | ChannelAuthorizationResult | Promise<boolean | ChannelAuthorizationResult>

/**
 * Channel-name registry — used by `Broadcaster.authorize(pattern, fn)`.
 * Supports exact names (`'orders.42'`) and trailing-wildcard patterns
 * (`'orders.*'`, `'presence-room-*'`). No regex; the wildcard is a
 * single `*` at the end. Keeps the implementation tight and avoids
 * regex-injection footguns.
 */
export class ChannelAuthorizerRegistry {
  private readonly exact = new Map<string, ChannelAuthorizer>()
  private readonly prefixes: Array<{ prefix: string; fn: ChannelAuthorizer }> = []

  register(pattern: string, fn: ChannelAuthorizer): void {
    if (pattern.endsWith('*')) {
      this.prefixes.push({ prefix: pattern.slice(0, -1), fn })
      // Longer prefixes first → "orders.special.*" wins over "orders.*".
      this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length)
      return
    }
    this.exact.set(pattern, fn)
  }

  /** Resolve the authorizer matching `channel`, or `undefined`. */
  match(channel: string): ChannelAuthorizer | undefined {
    const direct = this.exact.get(channel)
    if (direct !== undefined) return direct
    for (const { prefix, fn } of this.prefixes) {
      if (channel.startsWith(prefix)) return fn
    }
    return undefined
  }

  clear(): void {
    this.exact.clear()
    this.prefixes.length = 0
  }
}

/**
 * Normalise an authorizer's return value to the canonical
 * `ChannelAuthorizationResult` shape. Boolean returns become
 * `{ authorized: bool }`; the structured form passes through.
 */
export function normalizeAuthorizerResult(
  result: boolean | ChannelAuthorizationResult,
): ChannelAuthorizationResult {
  if (typeof result === 'boolean') return { authorized: result }
  return result
}
