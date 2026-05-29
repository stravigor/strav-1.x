/**
 * `GoogleSocialDriver` — Google Sign-In (OAuth 2.0 + OIDC) via
 * the standard Web application client type.
 *
 * Notes worth knowing:
 *
 *   - **Scopes**: `openid` (id_token), `profile`, `email`.
 *     Google accepts both short (`'email'`) and fully-qualified
 *     (`'https://www.googleapis.com/auth/userinfo.email'`) forms;
 *     we use the short forms.
 *
 *   - **PKCE**: supported. Mandatory for `installed` / SPA
 *     client types; optional for `Web application`. The driver
 *     defaults PKCE on as defence in depth (matches Line + the
 *     OAuth 2.1 trajectory).
 *
 *   - **Refresh tokens**: Google only issues `refresh_token` on
 *     `access_type=offline`. The driver defaults to including
 *     it. A `refresh_token` is returned ONLY on the user's
 *     first consent unless `prompt=consent` forces re-consent.
 *     Apps re-establishing offline access after revocation pass
 *     `extra: { prompt: 'consent' }`.
 *
 *   - **id_token**: returned when `openid` is in the requested
 *     scope set. Decoding helper provided for `email` extraction,
 *     mirroring `emailFromLineIdToken`. Signature verification
 *     deferred to apps (use Google's `tokeninfo` endpoint or a
 *     JWT library + Google's JWKS).
 *
 *   - **`hd` (hosted domain)**: Google Workspace constraint —
 *     pass `extra: { hd: 'example.com' }` on authorize to limit
 *     consent to one Workspace domain.
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
  SocialProviderError,
  StateMismatchError,
} from '../social_error.ts'
import { codeChallengeFor, randomCodeVerifier, randomState } from '../pkce.ts'
import { GOOGLE_ENDPOINTS, type GoogleProviderConfig } from './google_config.ts'

const PROVIDER = 'google'

const CAPS: readonly SocialCapability[] = [
  'openid', 'pkce.support',
  'profile.id', 'profile.email', 'profile.emailVerified',
  'profile.name', 'profile.avatar', 'profile.locale',
  'tokens.exchange', 'tokens.refresh', 'tokens.revoke', 'tokens.introspect',
  'scopes.discoverable',
]

const SCOPES: readonly string[] = ['openid', 'profile', 'email']

export interface GoogleDriverOptions {
  instanceName: string
  config: GoogleProviderConfig
}

interface TokenResponse {
  access_token: string
  expires_in: number
  id_token?: string
  refresh_token?: string
  scope?: string
  token_type: string
}

interface UserInfoResponse {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  locale?: string
}

interface JwtPayload {
  email?: string
  email_verified?: boolean
  sub?: string
  [k: string]: unknown
}

export class GoogleSocialDriver implements SocialDriver {
  readonly name = PROVIDER
  readonly instanceName: string
  readonly capabilities: ReadonlySet<SocialCapability> = new Set(CAPS)
  readonly availableScopes = SCOPES

  private readonly config: GoogleProviderConfig
  private readonly fetchFn: typeof fetch
  private readonly endpoints: {
    authorize: string
    token: string
    userInfo: string
    revoke: string
    tokenInfo: string
  }

  constructor(options: GoogleDriverOptions) {
    this.instanceName = options.instanceName
    this.config = options.config
    this.fetchFn = options.config.fetch ?? fetch
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...(options.config.endpoints ?? {}) }
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const state = input.state ?? randomState()
    const optOut = input.extra?.no_pkce === '1'
    const codeVerifier = optOut
      ? undefined
      : input.codeVerifier ?? randomCodeVerifier()
    const challenge = codeVerifier ? await codeChallengeFor(codeVerifier) : undefined

    const scopes = input.scopes ?? ['openid', 'profile', 'email']
    const offline = this.config.offlineAccess !== false

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: scopes.join(' '),
      state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      ...(offline ? { access_type: 'offline' } : {}),
      // `include_granted_scopes=true` makes Google merge previous
      // grants rather than replace — apps that progressively
      // request scopes appreciate it; safe-by-default.
      include_granted_scopes: 'true',
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
        `GoogleSocialDriver.exchange: token endpoint returned ${res.status}.`,
        { context: { status: res.status, body: text } },
      )
    }
    return this.toOAuthTokens((await res.json()) as TokenResponse)
  }

  async profile(accessToken: string): Promise<SocialProfile> {
    const res = await this.fetchFn(this.endpoints.userInfo, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (res.status === 401) {
      throw new InvalidTokenError('GoogleSocialDriver.profile: access token rejected.')
    }
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `GoogleSocialDriver.profile: userinfo endpoint returned ${res.status}.`,
        { provider: PROVIDER, operation: 'profile', context: { status: res.status, body: text } },
      )
    }
    const u = (await res.json()) as UserInfoResponse
    return {
      id: u.sub,
      provider: PROVIDER,
      ...(u.email ? { email: u.email } : {}),
      ...(u.email_verified !== undefined ? { emailVerified: u.email_verified } : {}),
      ...(u.name ? { name: u.name } : {}),
      ...(u.picture ? { avatarUrl: u.picture } : {}),
      ...(u.locale ? { locale: u.locale } : {}),
      metadata: {
        ...(u.given_name ? { givenName: u.given_name } : {}),
        ...(u.family_name ? { familyName: u.family_name } : {}),
      },
      raw: u,
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
        `GoogleSocialDriver.refresh: refresh token rejected.`,
        { context: { status: res.status, body: text } },
      )
    }
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `GoogleSocialDriver.refresh: token endpoint returned ${res.status}.`,
        { provider: PROVIDER, operation: 'refresh', context: { status: res.status, body: text } },
      )
    }
    // Google does NOT rotate refresh tokens; preserve the caller's
    // current refresh token if the response omits it.
    const json = (await res.json()) as TokenResponse
    const tokens = this.toOAuthTokens(json)
    if (!tokens.refreshToken) tokens.refreshToken = input.refreshToken
    return tokens
  }

  async revoke(token: string): Promise<void> {
    // Google's revoke endpoint takes the token as a query
    // parameter OR a form body; we POST form for consistency
    // with the rest of the driver.
    const body = new URLSearchParams({ token })
    const res = await this.fetchFn(this.endpoints.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new SocialProviderError(
        `GoogleSocialDriver.revoke: revoke endpoint returned ${res.status}.`,
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
    return {
      accessToken: t.access_token,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      ...(t.id_token ? { idToken: t.id_token } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      tokenType: t.token_type ?? 'Bearer',
      raw: t,
    }
  }
}

/**
 * Extract the `email` claim from a Google id_token (JWT). Same
 * semantics as `emailFromLineIdToken` — decode-only, no JWS
 * signature verification. Apps with stricter posture verify via
 * Google's `tokeninfo?id_token=...` endpoint.
 *
 * Google's userinfo endpoint also returns `email` + `email_verified`,
 * so most apps don't need this helper — it's here for paths that
 * skip userinfo (e.g. server-only signin where the access token
 * is discarded immediately after exchange).
 */
export function emailFromGoogleIdToken(idToken: string): string | null {
  const segments = idToken.split('.')
  if (segments.length !== 3) {
    throw new InvalidTokenError(
      'emailFromGoogleIdToken: id_token does not have 3 segments.',
    )
  }
  const payload = decodeJwtSegment(segments[1]!)
  return typeof payload.email === 'string' ? payload.email : null
}

function decodeJwtSegment(segment: string): JwtPayload {
  const pad = segment.length % 4
  const padded = pad === 0 ? segment : `${segment}${'='.repeat(4 - pad)}`
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return JSON.parse(atob(b64)) as JwtPayload
  } catch (cause) {
    throw new InvalidTokenError('decodeJwtSegment: failed to parse JWT segment.', {
      cause,
    })
  }
}
