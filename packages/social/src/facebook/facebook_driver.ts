/**
 * `FacebookSocialDriver` — Facebook Login via the Graph API.
 *
 * Notable divergences from Line / Google:
 *
 *   - **No OIDC.** Facebook does not issue `id_token`; the
 *     driver omits the `openid` capability. Apps that want a
 *     verifiable JWT use a different provider.
 *
 *   - **No refresh tokens.** Facebook hands out short-lived
 *     (~1–2h) access tokens and a separate "long-lived token
 *     exchange" path that swaps the access token itself for a
 *     ~60-day variant. That's not a refresh-token grant in the
 *     framework's sense, so the driver omits the `tokens.refresh`
 *     capability and throws `ProviderUnsupportedError` from
 *     `refresh()`. Use `exchangeForLongLivedToken()` directly for
 *     the Facebook-specific flow.
 *
 *   - **Email needs App Review.** Apps that ship the `email`
 *     scope to non-developer users have to go through Meta's
 *     review. The capability flag is declared because the
 *     driver CAN return email when granted — but apps gate the
 *     scope picker / button visibility on their own deployment
 *     state.
 *
 *   - **`emailVerified` not asserted.** Facebook does not
 *     surface verification state; apps that need verified email
 *     send their own confirmation.
 *
 *   - **Revoke** issues `DELETE /me/permissions`, which clears
 *     ALL granted scopes for the user. There's no per-scope
 *     revoke through the framework; apps that need it call the
 *     Graph API directly.
 */

import type { OAuthTokens, SocialProfile } from '../dto/index.ts'
import type { SocialCapability } from '../social_capabilities.ts'
import type {
  AuthorizeInput,
  AuthorizeResult,
  ExchangeInput,
  RefreshInput,
  SocialDriver,
} from '../social_driver.ts'
import {
  InvalidTokenError,
  OAuthExchangeError,
  ProviderUnsupportedError,
  SocialProviderError,
  StateMismatchError,
} from '../social_error.ts'
import { codeChallengeFor, randomCodeVerifier, randomState } from '../pkce.ts'
import {
  DEFAULT_FACEBOOK_PROFILE_FIELDS,
  facebookEndpoints,
  type FacebookProviderConfig,
} from './facebook_config.ts'

const PROVIDER = 'facebook'

const CAPS: readonly SocialCapability[] = [
  // No `openid` — Facebook is plain OAuth2, no id_token.
  'pkce.support',
  'profile.id', 'profile.email', 'profile.name', 'profile.avatar', 'profile.locale',
  // No `profile.emailVerified` — Facebook doesn't assert verification.
  'tokens.exchange',
  // No `tokens.refresh` — see `exchangeForLongLivedToken` instead.
  'tokens.revoke', 'tokens.introspect',
  'scopes.discoverable',
]

const SCOPES: readonly string[] = ['public_profile', 'email']

export interface FacebookDriverOptions {
  instanceName: string
  config: FacebookProviderConfig
}

interface TokenResponse {
  access_token: string
  expires_in?: number
  token_type: string
  scope?: string
}

interface PicturePayload {
  data?: { url?: string; is_silhouette?: boolean }
}

interface MeResponse {
  id: string
  name?: string
  email?: string
  first_name?: string
  last_name?: string
  picture?: PicturePayload
  locale?: string
}

interface DebugTokenResponse {
  data?: {
    user_id?: string
    app_id?: string
    is_valid?: boolean
    expires_at?: number
    scopes?: string[]
  }
}

export class FacebookSocialDriver implements SocialDriver {
  readonly name = PROVIDER
  readonly instanceName: string
  readonly capabilities: ReadonlySet<SocialCapability> = new Set(CAPS)
  readonly availableScopes = SCOPES

  private readonly config: FacebookProviderConfig
  private readonly fetchFn: typeof fetch
  private readonly endpoints: ReturnType<typeof facebookEndpoints>
  private readonly profileFields: readonly string[]

  constructor(options: FacebookDriverOptions) {
    this.instanceName = options.instanceName
    this.config = options.config
    this.fetchFn = options.config.fetch ?? fetch
    this.endpoints = {
      ...facebookEndpoints(options.config.graphVersion),
      ...(options.config.endpoints ?? {}),
    }
    this.profileFields = options.config.profileFields ?? DEFAULT_FACEBOOK_PROFILE_FIELDS
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const state = input.state ?? randomState()
    const optOut = input.extra?.no_pkce === '1'
    const codeVerifier = optOut
      ? undefined
      : input.codeVerifier ?? randomCodeVerifier()
    const challenge = codeVerifier ? await codeChallengeFor(codeVerifier) : undefined

    const scopes = input.scopes ?? ['public_profile']
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: scopes.join(','), // Facebook accepts comma OR space; comma is canonical.
      state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      ...(input.extra ?? {}),
    })
    params.delete('no_pkce')

    return {
      url: `${this.endpoints.authorize}?${params.toString()}`,
      state,
      ...(codeVerifier ? { codeVerifier } : {}),
    }
  }

  async exchange(input: ExchangeInput): Promise<OAuthTokens> {
    if (input.expectedState !== undefined && input.state !== input.expectedState) {
      throw new StateMismatchError()
    }
    // Facebook accepts GET with query string OR POST with form;
    // we use POST form for symmetry with Line/Google.
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    })
    const res = await this.fetchFn(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new OAuthExchangeError(
        `FacebookSocialDriver.exchange: token endpoint returned ${res.status}.`,
        { context: { status: res.status, body: text } },
      )
    }
    return this.toOAuthTokens((await res.json()) as TokenResponse)
  }

  async profile(accessToken: string): Promise<SocialProfile> {
    const url = `${this.endpoints.me}?${new URLSearchParams({
      fields: this.profileFields.join(','),
      access_token: accessToken,
    }).toString()}`
    const res = await this.fetchFn(url)
    if (res.status === 401 || res.status === 400) {
      // Facebook returns 400 for revoked / expired tokens (not 401).
      throw new InvalidTokenError('FacebookSocialDriver.profile: access token rejected.')
    }
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `FacebookSocialDriver.profile: Graph API returned ${res.status}.`,
        { provider: PROVIDER, operation: 'profile', context: { status: res.status, body: text } },
      )
    }
    const me = (await res.json()) as MeResponse
    return {
      id: me.id,
      provider: PROVIDER,
      ...(me.email ? { email: me.email } : {}),
      ...(me.name ? { name: me.name } : {}),
      ...(me.picture?.data?.url ? { avatarUrl: me.picture.data.url } : {}),
      ...(me.locale ? { locale: me.locale } : {}),
      metadata: {
        ...(me.first_name ? { firstName: me.first_name } : {}),
        ...(me.last_name ? { lastName: me.last_name } : {}),
        ...(me.picture?.data?.is_silhouette
          ? { isSilhouette: me.picture.data.is_silhouette }
          : {}),
      },
      raw: me,
    }
  }

  refresh(_input: RefreshInput): Promise<OAuthTokens> {
    throw new ProviderUnsupportedError(PROVIDER, 'tokens.refresh', {
      reason:
        'Facebook does not issue refresh tokens. Use `exchangeForLongLivedToken(accessToken, driver)` to swap a short-lived access token for the ~60-day variant — note this trades the access token itself, not a separate refresh token.',
    })
  }

  async revoke(token: string): Promise<void> {
    // DELETE /me/permissions clears every scope this user
    // granted to the app. Per-scope revoke isn't bridged; apps
    // that need it call the Graph API directly.
    const url = `${this.endpoints.permissions}?${new URLSearchParams({
      access_token: token,
    }).toString()}`
    const res = await this.fetchFn(url, { method: 'DELETE' })
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `FacebookSocialDriver.revoke: Graph API returned ${res.status}.`,
        { provider: PROVIDER, operation: 'revoke', context: { status: res.status, body: text } },
      )
    }
  }

  // ─── Facebook-specific helpers (advanced) ───────────────────────────

  /**
   * Trade a short-lived access token (~1–2h) for a long-lived
   * one (~60 days). Facebook calls this `fb_exchange_token`; the
   * framework's `refresh()` throws because it doesn't fit the
   * refresh-token contract. Apps that hold tokens across sessions
   * call this once after the initial exchange.
   */
  async exchangeForLongLivedToken(accessToken: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      fb_exchange_token: accessToken,
    })
    const res = await this.fetchFn(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.status === 400 || res.status === 401) {
      throw new InvalidTokenError(
        `FacebookSocialDriver.exchangeForLongLivedToken: short-lived token rejected.`,
        { context: { status: res.status } },
      )
    }
    if (!res.ok) {
      throw new SocialProviderError(
        `FacebookSocialDriver.exchangeForLongLivedToken: Graph API returned ${res.status}.`,
        { provider: PROVIDER, operation: 'long_lived_exchange', context: { status: res.status } },
      )
    }
    return this.toOAuthTokens((await res.json()) as TokenResponse)
  }

  /**
   * Inspect a token via the Graph API's `debug_token` endpoint.
   * Returns the raw payload — apps read `is_valid`, `expires_at`,
   * `scopes`, etc. Implementation note: the `input_token` is what
   * we're checking; the `access_token` is the *app* token used to
   * authenticate the call (`client_id|client_secret`).
   */
  async debugToken(token: string): Promise<DebugTokenResponse> {
    const appToken = `${this.config.clientId}|${this.config.clientSecret}`
    const url = `${this.endpoints.debugToken}?${new URLSearchParams({
      input_token: token,
      access_token: appToken,
    }).toString()}`
    const res = await this.fetchFn(url)
    if (!res.ok) {
      throw new SocialProviderError(
        `FacebookSocialDriver.debugToken: Graph API returned ${res.status}.`,
        { provider: PROVIDER, operation: 'introspect', context: { status: res.status } },
      )
    }
    return (await res.json()) as DebugTokenResponse
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private toOAuthTokens(t: TokenResponse): OAuthTokens {
    const expiresAt =
      typeof t.expires_in === 'number'
        ? new Date(Date.now() + t.expires_in * 1000)
        : undefined
    return {
      accessToken: t.access_token,
      ...(expiresAt ? { expiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      tokenType: t.token_type ?? 'Bearer',
      raw: t,
    }
  }
}
