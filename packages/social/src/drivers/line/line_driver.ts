/**
 * `LineSocialDriver` — Line Login v2.1 implementation.
 *
 * Line is SEA-load-bearing: dominant chat + login in Thailand
 * and Japan, growing across SEA more generally. Strav defaults
 * to Line as the primary social adapter; Google + Facebook
 * round out the international + global-reach options.
 *
 * Line specifics worth knowing:
 *
 *   - **Scopes**: `profile` (always free), `openid` (free —
 *     returns an id_token), `email` (requires Line approval on
 *     the channel, then granted per-user via the consent screen).
 *   - **PKCE**: supported, not required.
 *   - **Email**: only available by decoding the id_token JWT
 *     when `openid email` was both requested AND granted. Line
 *     does NOT include email on the `/v2/profile` REST response.
 *   - **id_token verification**: the driver decodes JWT claims
 *     for the `email` field but does NOT verify the JWS
 *     signature. The token arrives over TLS direct from Line's
 *     token endpoint, so the trust boundary is the same as the
 *     access token. Apps that want signature verification
 *     against Line's JWKS run it themselves or use the
 *     `/oauth2/v2.1/verify` endpoint via `driver.client`.
 *   - **No locale field on profile** — apps that need it pass
 *     `ui_locales` on authorize and store the app-side choice
 *     alongside the user record.
 *
 * Token / refresh / revoke all use the standard OAuth2 endpoints.
 */

import type { OAuthTokens, SocialProfile } from '../../dto/index.ts'
import type { SocialCapability } from '../../social_capabilities.ts'
import type {
  AuthorizeInput,
  AuthorizeResult,
  ExchangeInput,
  RefreshInput,
  SocialDriver,
} from '../../social_driver.ts'
import {
  InvalidTokenError,
  OAuthExchangeError,
  SocialProviderError,
  StateMismatchError,
} from '../../social_error.ts'
import { codeChallengeFor, randomCodeVerifier, randomState } from '../../pkce.ts'
import { LINE_ENDPOINTS, type LineProviderConfig } from './line_config.ts'

const PROVIDER = 'line'

const CAPS: readonly SocialCapability[] = [
  'openid', 'pkce.support',
  'profile.id', 'profile.email', 'profile.emailVerified',
  'profile.name', 'profile.avatar',
  // No `profile.locale` — Line doesn't return locale on the profile API.
  'tokens.exchange', 'tokens.refresh', 'tokens.revoke', 'tokens.introspect',
  'scopes.discoverable',
]

const SCOPES: readonly string[] = ['openid', 'profile', 'email']

export interface LineDriverOptions {
  instanceName: string
  config: LineProviderConfig
}

interface TokenResponse {
  access_token: string
  expires_in: number
  id_token?: string
  refresh_token?: string
  scope?: string
  token_type: string
}

interface ProfileResponse {
  userId: string
  displayName: string
  pictureUrl?: string
  statusMessage?: string
}

interface JwtPayload {
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  sub?: string
  [k: string]: unknown
}

export class LineSocialDriver implements SocialDriver {
  readonly name = PROVIDER
  readonly instanceName: string
  readonly capabilities: ReadonlySet<SocialCapability> = new Set(CAPS)
  readonly availableScopes = SCOPES

  private readonly config: LineProviderConfig
  private readonly fetchFn: typeof fetch
  private readonly endpoints: { authorize: string; token: string; profile: string; revoke: string; verify: string }

  constructor(options: LineDriverOptions) {
    this.instanceName = options.instanceName
    this.config = options.config
    this.fetchFn = options.config.fetch ?? fetch
    this.endpoints = { ...LINE_ENDPOINTS, ...(options.config.endpoints ?? {}) }
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const state = input.state ?? randomState()
    // PKCE: Line supports but doesn't require. We default to
    // including it (defence in depth for callback hijacking on
    // mobile + SPA flows; harmless on server-side flows). Apps
    // that explicitly pass `codeVerifier: undefined` opt out by
    // sending `extra.no_pkce: '1'`.
    const optOut = input.extra?.no_pkce === '1'
    const codeVerifier = optOut
      ? undefined
      : input.codeVerifier ?? randomCodeVerifier()
    const challenge = codeVerifier ? await codeChallengeFor(codeVerifier) : undefined

    const scopes = input.scopes ?? ['profile']
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: scopes.join(' '),
      state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      ...(this.config.uiLocales ? { ui_locales: this.config.uiLocales } : {}),
      ...(input.extra ?? {}),
    })
    // Don't leak the framework helper through to Line.
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
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
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
        `LineSocialDriver.exchange: token endpoint returned ${res.status}.`,
        { context: { status: res.status, body: text } },
      )
    }
    const json = (await res.json()) as TokenResponse
    return this.toOAuthTokens(json)
  }

  async profile(accessToken: string): Promise<SocialProfile> {
    const res = await this.fetchFn(this.endpoints.profile, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (res.status === 401) {
      throw new InvalidTokenError('LineSocialDriver.profile: access token rejected.')
    }
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `LineSocialDriver.profile: profile endpoint returned ${res.status}.`,
        { provider: PROVIDER, operation: 'profile', context: { status: res.status, body: text } },
      )
    }
    const p = (await res.json()) as ProfileResponse
    return {
      id: p.userId,
      provider: PROVIDER,
      ...(p.displayName ? { name: p.displayName } : {}),
      ...(p.pictureUrl ? { avatarUrl: p.pictureUrl } : {}),
      // Email is NOT on /v2/profile. Apps that need it decoded the
      // id_token at exchange time and stored it on the user record.
      metadata: p.statusMessage ? { statusMessage: p.statusMessage } : {},
      raw: p,
    }
  }

  async refresh(input: RefreshInput): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    })
    const res = await this.fetchFn(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.status === 400 || res.status === 401) {
      const text = await res.text()
      throw new InvalidTokenError(
        `LineSocialDriver.refresh: refresh token rejected.`,
        { context: { status: res.status, body: text } },
      )
    }
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `LineSocialDriver.refresh: token endpoint returned ${res.status}.`,
        { provider: PROVIDER, operation: 'refresh', context: { status: res.status, body: text } },
      )
    }
    return this.toOAuthTokens((await res.json()) as TokenResponse)
  }

  async revoke(token: string): Promise<void> {
    const body = new URLSearchParams({
      access_token: token,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    })
    const res = await this.fetchFn(this.endpoints.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `LineSocialDriver.revoke: revoke endpoint returned ${res.status}.`,
        { provider: PROVIDER, operation: 'revoke', context: { status: res.status, body: text } },
      )
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private toOAuthTokens(t: TokenResponse): OAuthTokens {
    const expiresAt =
      typeof t.expires_in === 'number'
        ? new Date(Date.now() + t.expires_in * 1000)
        : undefined
    const tokens: OAuthTokens = {
      accessToken: t.access_token,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      ...(t.id_token ? { idToken: t.id_token } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      tokenType: t.token_type ?? 'Bearer',
      raw: t,
    }
    return tokens
  }
}

/**
 * Extract `email` from a Line id_token. Returns the email
 * string when present, `null` when the id_token has no email
 * claim (typical when `email` scope wasn't requested or
 * granted), and throws when the token is structurally invalid.
 *
 * Apps that need the email at signup time decode the id_token
 * right after `exchange()`. The framework deliberately keeps
 * this as a side helper rather than auto-decoding inside
 * `exchange()` — the OIDC id_token has many claims; surfacing
 * email-only matches the most common app need, anything else
 * stays on `tokens.idToken` for apps to parse themselves.
 *
 * **Security note**: this does NOT verify the JWS signature.
 * The id_token arrives over TLS direct from Line's token
 * endpoint in the same response as the access token; trusting
 * the payload at that point has the same posture as trusting
 * the access token. Apps that want full verification call
 * Line's `/oauth2/v2.1/verify` endpoint with the id_token.
 */
export function emailFromLineIdToken(idToken: string): string | null {
  const segments = idToken.split('.')
  if (segments.length !== 3) {
    throw new InvalidTokenError('emailFromLineIdToken: id_token does not have 3 segments.')
  }
  const payload = decodeJwtSegment(segments[1]!)
  return typeof payload.email === 'string' ? payload.email : null
}

function decodeJwtSegment(segment: string): JwtPayload {
  // base64url → base64 → string
  const pad = segment.length % 4
  const padded = pad === 0 ? segment : `${segment}${'='.repeat(4 - pad)}`
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const json = atob(b64)
    return JSON.parse(json) as JwtPayload
  } catch (cause) {
    throw new InvalidTokenError('decodeJwtSegment: failed to parse JWT segment.', {
      cause,
    })
  }
}
