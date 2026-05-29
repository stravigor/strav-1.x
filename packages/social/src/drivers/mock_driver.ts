/**
 * `MockDriver` — in-memory reference implementation. Used by
 * unit tests + as the canonical contract example for new
 * adapters.
 *
 * Round-trips tokens + profiles through plain Maps. PKCE +
 * state verification mirror what real drivers enforce so apps
 * exercising the full flow against the mock catch bugs in
 * their state handling before they hit a real provider.
 *
 * Capabilities: full by default — every flag declared. Tests
 * that exercise `ProviderUnsupportedError` paths construct the
 * mock with a narrowed `capabilities` set.
 */

import { ulid } from '@strav/kernel'
import {
  InvalidTokenError,
  OAuthExchangeError,
  StateMismatchError,
} from '../social_error.ts'
import type { OAuthTokens, SocialProfile } from '../dto/index.ts'
import type { SocialCapability } from '../social_capabilities.ts'
import { codeChallengeFor, randomCodeVerifier, randomState } from '../pkce.ts'
import type {
  AuthorizeInput,
  AuthorizeResult,
  ExchangeInput,
  RefreshInput,
  SocialDriver,
} from '../social_driver.ts'

const ALL_CAPS: readonly SocialCapability[] = [
  'openid', 'pkce.support',
  'profile.id', 'profile.email', 'profile.emailVerified',
  'profile.name', 'profile.avatar', 'profile.locale',
  'tokens.exchange', 'tokens.refresh', 'tokens.revoke', 'tokens.introspect',
  'scopes.discoverable',
]

export interface MockDriverOptions {
  instanceName?: string
  capabilities?: ReadonlySet<SocialCapability>
  /** Profile returned by `profile(accessToken)` calls. Tests override to assert specific shapes. */
  profileFor?(accessToken: string): SocialProfile
}

interface PendingFlow {
  state: string
  codeVerifier?: string
  scopes: readonly string[]
  redirectUri: string
}

export class MockDriver implements SocialDriver {
  readonly name = 'mock'
  readonly instanceName: string
  readonly capabilities: ReadonlySet<SocialCapability>
  readonly availableScopes: readonly string[] = ['openid', 'profile', 'email']

  private readonly pending = new Map<string, PendingFlow>()
  private readonly issuedTokens = new Map<string, { code: string; refreshToken: string }>()
  private readonly profileForFn: (accessToken: string) => SocialProfile

  constructor(options: MockDriverOptions = {}) {
    this.instanceName = options.instanceName ?? 'mock'
    this.capabilities = options.capabilities ?? new Set(ALL_CAPS)
    this.profileForFn =
      options.profileFor ??
      ((token: string): SocialProfile => ({
        id: `mock_${token.slice(0, 8)}`,
        provider: this.name,
        email: `${token.slice(0, 6)}@mock.test`,
        emailVerified: true,
        name: 'Mock User',
        avatarUrl: 'https://mock.test/avatar.png',
        locale: 'en',
        metadata: {},
        raw: { mock: true },
      }))
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const state = input.state ?? randomState()
    const codeVerifier =
      input.codeVerifier ??
      (this.capabilities.has('pkce.support') ? randomCodeVerifier() : undefined)
    const challenge = codeVerifier ? await codeChallengeFor(codeVerifier) : undefined
    this.pending.set(state, {
      state,
      ...(codeVerifier ? { codeVerifier } : {}),
      scopes: input.scopes ?? ['profile'],
      redirectUri: input.redirectUri,
    })
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'mock_client',
      redirect_uri: input.redirectUri,
      scope: (input.scopes ?? ['profile']).join(' '),
      state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      ...(input.extra ?? {}),
    })
    return {
      url: `https://mock.test/oauth/authorize?${params.toString()}`,
      state,
      ...(codeVerifier ? { codeVerifier } : {}),
    }
  }

  async exchange(input: ExchangeInput): Promise<OAuthTokens> {
    if (input.expectedState !== undefined && input.state !== input.expectedState) {
      throw new StateMismatchError()
    }
    const flow = input.state ? this.pending.get(input.state) : undefined
    if (!flow) {
      throw new OAuthExchangeError('MockDriver: no pending authorize for this state.')
    }
    if (flow.codeVerifier && flow.codeVerifier !== input.codeVerifier) {
      throw new OAuthExchangeError('MockDriver: PKCE verifier mismatch.')
    }
    this.pending.delete(input.state!)
    const accessToken = `mock_at_${ulid()}`
    const refreshToken = `mock_rt_${ulid()}`
    this.issuedTokens.set(accessToken, { code: input.code, refreshToken })
    return {
      accessToken,
      refreshToken,
      ...(flow.scopes.includes('openid') ? { idToken: `mock_id_${ulid()}` } : {}),
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scope: flow.scopes.join(' '),
      tokenType: 'Bearer',
      raw: { mock: true, code: input.code },
    }
  }

  async profile(accessToken: string): Promise<SocialProfile> {
    if (!this.issuedTokens.has(accessToken)) {
      throw new InvalidTokenError(`MockDriver.profile: unknown access token.`)
    }
    return this.profileForFn(accessToken)
  }

  async refresh(input: RefreshInput): Promise<OAuthTokens> {
    // Find the access token whose refresh token matches.
    const found = [...this.issuedTokens.entries()].find(
      ([, v]) => v.refreshToken === input.refreshToken,
    )
    if (!found) {
      throw new InvalidTokenError('MockDriver.refresh: unknown refresh token.')
    }
    // Rotate.
    this.issuedTokens.delete(found[0])
    const accessToken = `mock_at_${ulid()}`
    const newRefresh = `mock_rt_${ulid()}`
    this.issuedTokens.set(accessToken, { code: found[1].code, refreshToken: newRefresh })
    return {
      accessToken,
      refreshToken: newRefresh,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scope: (input.scopes ?? []).join(' '),
      tokenType: 'Bearer',
      raw: { mock: true },
    }
  }

  async revoke(token: string): Promise<void> {
    this.issuedTokens.delete(token)
  }
}
