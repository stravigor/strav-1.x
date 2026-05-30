/**
 * `SocialDriver` — the driver contract every adapter implements.
 *
 * One driver represents a configured provider instance
 * (`config.social.providers[name]`). The manager holds one
 * driver per configured name and routes calls into it.
 *
 * ## Capability gating — the "honest LSP violation" pattern
 *
 * Strictly speaking, the interface below violates Liskov substitution
 * because `FacebookSocialDriver.refresh()` throws synchronously instead
 * of returning `Promise<OAuthTokens>` (Facebook doesn't issue refresh
 * tokens). Same shape for any future driver that lacks an operation
 * its interface declares.
 *
 * The framework prefers this trade-off over the alternative (every
 * provider gets its own narrowed sub-interface, every app does a
 * `if (isRefreshable(driver))` narrowing dance) for three reasons:
 *
 *   1. **Discoverability**: apps see ONE `SocialDriver` interface
 *      with all the operations a sign-in flow needs. They learn the
 *      surface once, not per-adapter.
 *
 *   2. **Capability flags are the typed truth**: each driver
 *      declares `capabilities: ReadonlySet<SocialCapability>`. Apps
 *      that care about portability check the flag and branch — the
 *      `unsupported` throw becomes the safety net for callers who
 *      forgot, not the primary API.
 *
 *   3. **Failures are loud and synchronous**. Drivers use the
 *      `unsupported(provider, op, reason?)` helper so the throw
 *      happens on the function call, NOT after a network round-trip
 *      had a chance to bill the user / consume rate limit. Apps fail
 *      fast.
 *
 * Apps that want compile-time safety against unsupported ops wrap the
 * driver themselves:
 *
 * ```ts
 * function refreshableDriver(d: SocialDriver) {
 *   if (!d.capabilities.has('tokens.refresh')) return null
 *   return d  // narrowed by convention; refresh() is now safe to call.
 * }
 * ```
 *
 * A split into `SocialDriver` + `RefreshableSocialDriver` + ... may
 * land later (`docs/code-quality.md` action item #4) — but doing so
 * carries the manager's `use(name): SocialDriver` return type through
 * a wider refactor. Until then, the capability set IS the contract.
 */

import type { OAuthTokens, SocialProfile } from './dto/index.ts'
import type { SocialCapability } from './social_capabilities.ts'

export interface AuthorizeInput {
  /**
   * Where the provider redirects after consent. Must match
   * what's registered in the provider's developer console.
   */
  redirectUri: string
  /**
   * OAuth scope list. Drivers expose `availableScopes` for
   * apps that want to render a picker; apps usually hard-code
   * `['profile', 'email']` or `['openid', 'profile', 'email']`.
   */
  scopes?: readonly string[]
  /**
   * Override the CSRF state. When omitted, the driver generates
   * one via `randomState()`. Apps that already have a
   * session-bound nonce (and want to use it as state) pass it
   * here.
   */
  state?: string
  /**
   * Override the PKCE code verifier. When omitted AND the driver
   * supports/requires PKCE, the driver generates one and returns
   * it on the result. Apps store the returned verifier against
   * the session for the callback step.
   */
  codeVerifier?: string
  /**
   * Provider-specific extra query parameters (e.g. `prompt`,
   * `access_type`, `bot_prompt` for Line). The driver merges
   * these into the authorize URL after the standard params.
   */
  extra?: Record<string, string>
}

export interface AuthorizeResult {
  /** The full URL the app redirects the customer to. */
  url: string
  state: string
  /** Set when the driver issued / accepted a PKCE verifier. Apps persist this against the session. */
  codeVerifier?: string
}

export interface ExchangeInput {
  code: string
  redirectUri: string
  /** Pass the state value the app stored at authorize-time. The driver verifies it matches `expectedState` (which the app provides on the callback). */
  state?: string
  /** Expected state — `state` from the AuthorizeResult the app stored. */
  expectedState?: string
  /** PKCE verifier — required by drivers that declared `pkce.required`. */
  codeVerifier?: string
}

export interface RefreshInput {
  refreshToken: string
  /** Optional narrowed scope list. Most providers ignore this. */
  scopes?: readonly string[]
}

export interface SocialDriver {
  /** Driver identifier — `'line'` / `'google'` / `'facebook'`. */
  readonly name: string
  /** App-chosen instance name (`config.social.providers[name]`). */
  readonly instanceName: string
  readonly capabilities: ReadonlySet<SocialCapability>
  /** Provider-supported scope list. Apps render pickers from this; drivers reject unknown scopes at authorize time. */
  readonly availableScopes: readonly string[]

  /** Build the authorize URL + emit state / PKCE artefacts the app stores. */
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>

  /** Exchange the callback code for tokens. Verifies state when both `state` and `expectedState` are provided. */
  exchange(input: ExchangeInput): Promise<OAuthTokens>

  /** Fetch the normalized user profile using a valid access token. */
  profile(accessToken: string): Promise<SocialProfile>

  /** Trade a refresh token for a fresh access token. Drivers without the `tokens.refresh` capability throw. */
  refresh(input: RefreshInput): Promise<OAuthTokens>

  /** Revoke a token. Drivers without `tokens.revoke` throw. */
  revoke(token: string): Promise<void>
}

/** Factory the manager invokes per configured provider. */
export type SocialDriverFactory = (config: {
  instanceName: string
  config: Record<string, unknown> & { driver: string }
}) => SocialDriver
