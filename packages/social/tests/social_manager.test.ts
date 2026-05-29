/**
 * Slice 8.1 — core skeleton smoke tests.
 *
 * Exercises:
 *   - SocialManager driver routing (default + named + extend + useDriver).
 *   - SocialConfigError + UnknownProviderError boundary cases.
 *   - MockDriver authorize → exchange → profile → refresh → revoke flow.
 *   - State + PKCE verification under the mock.
 *   - PKCE helpers (verifier randomness, S256 challenge derivation).
 */

import { describe, expect, test } from 'bun:test'
import {
  codeChallengeFor,
  InvalidTokenError,
  MockDriver,
  OAuthExchangeError,
  randomCodeVerifier,
  randomState,
  SocialConfigError,
  SocialManager,
  StateMismatchError,
  UnknownProviderError,
} from '../src/index.ts'

function makeManager() {
  const manager = new SocialManager({
    config: {
      default: 'mock',
      providers: { mock: { driver: 'mock' }, secondary: { driver: 'mock' } },
    },
  })
  manager.extend('mock', ({ instanceName }) => new MockDriver({ instanceName }))
  return manager
}

describe('SocialManager — driver routing', () => {
  test('resolves the default driver lazily + memoizes', () => {
    const m = makeManager()
    const a = m.use()
    const b = m.use()
    expect(a).toBe(b)
    expect(a.instanceName).toBe('mock')
  })

  test('resolves a named provider', () => {
    const m = makeManager()
    expect(m.use('secondary').instanceName).toBe('secondary')
  })

  test('UnknownProviderError for unknown name', () => {
    const m = makeManager()
    expect(() => m.use('nope')).toThrow(UnknownProviderError)
  })

  test('SocialConfigError when default provider missing from config', () => {
    expect(
      () =>
        new SocialManager({
          config: { default: 'missing', providers: {} },
        }),
    ).toThrow(SocialConfigError)
  })

  test('SocialConfigError when driver factory not registered', () => {
    const m = new SocialManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    expect(() => m.use()).toThrow(SocialConfigError)
  })

  test('useDriver hand-wires an instance', () => {
    const m = new SocialManager({
      config: { default: 'mock', providers: { mock: { driver: 'mock' } } },
    })
    const driver = new MockDriver({ instanceName: 'mock' })
    m.useDriver('mock', driver)
    expect(m.use()).toBe(driver)
  })
})

describe('MockDriver — authorize → exchange → profile round-trip', () => {
  test('happy path with PKCE + state verification', async () => {
    const m = makeManager()
    const { url, state, codeVerifier } = await m.authorize({
      redirectUri: 'https://app.test/cb',
      scopes: ['openid', 'profile', 'email'],
    })
    expect(url).toContain('mock.test/oauth/authorize')
    expect(url).toContain('code_challenge=')
    expect(url).toContain('code_challenge_method=S256')
    expect(codeVerifier).toBeDefined()

    const tokens = await m.exchange({
      code: 'mock_authcode',
      redirectUri: 'https://app.test/cb',
      state,
      expectedState: state,
      ...(codeVerifier !== undefined ? { codeVerifier } : {}),
    })
    expect(tokens.accessToken.startsWith('mock_at_')).toBe(true)
    expect(tokens.refreshToken?.startsWith('mock_rt_')).toBe(true)
    expect(tokens.idToken).toBeDefined()
    expect(tokens.expiresAt).toBeInstanceOf(Date)

    const profile = await m.profile(tokens.accessToken)
    expect(profile.provider).toBe('mock')
    expect(profile.email).toContain('@mock.test')

    const refreshed = await m.refresh({ refreshToken: tokens.refreshToken! })
    expect(refreshed.accessToken).not.toBe(tokens.accessToken)

    await m.revoke(refreshed.accessToken)
    await expect(m.profile(refreshed.accessToken)).rejects.toThrow(InvalidTokenError)
  })

  test('expectedState mismatch → StateMismatchError', async () => {
    const m = makeManager()
    const { state, codeVerifier } = await m.authorize({ redirectUri: 'https://app/cb' })
    await expect(
      m.exchange({
        code: 'x',
        redirectUri: 'https://app/cb',
        state,
        expectedState: 'different',
        ...(codeVerifier !== undefined ? { codeVerifier } : {}),
      }),
    ).rejects.toThrow(StateMismatchError)
  })

  test('wrong PKCE verifier → OAuthExchangeError', async () => {
    const m = makeManager()
    const { state } = await m.authorize({ redirectUri: 'https://app/cb' })
    await expect(
      m.exchange({
        code: 'x',
        redirectUri: 'https://app/cb',
        state,
        expectedState: state,
        codeVerifier: 'wrong',
      }),
    ).rejects.toThrow(OAuthExchangeError)
  })

  test('no pending authorize for state → OAuthExchangeError', async () => {
    const m = makeManager()
    await expect(
      m.exchange({
        code: 'x',
        redirectUri: 'https://app/cb',
        state: 'never_seen',
        expectedState: 'never_seen',
      }),
    ).rejects.toThrow(OAuthExchangeError)
  })

  test('profile with unknown access token → InvalidTokenError', async () => {
    const m = makeManager()
    await expect(m.profile('bogus_token')).rejects.toThrow(InvalidTokenError)
  })

  test('refresh with unknown refresh token → InvalidTokenError', async () => {
    const m = makeManager()
    await expect(m.refresh({ refreshToken: 'bogus' })).rejects.toThrow(InvalidTokenError)
  })

  test('capability set is full by default', () => {
    const m = makeManager()
    const d = m.use()
    for (const cap of ['openid', 'pkce.support', 'profile.email', 'tokens.refresh', 'tokens.revoke'] as const) {
      expect(d.capabilities.has(cap)).toBe(true)
    }
  })
})

describe('PKCE helpers', () => {
  test('randomCodeVerifier is high-entropy + length-stable', () => {
    const a = randomCodeVerifier()
    const b = randomCodeVerifier()
    expect(a).not.toBe(b)
    expect(a.length).toBe(64)
  })

  test('codeChallengeFor is deterministic + base64url-safe', async () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const c1 = await codeChallengeFor(v)
    const c2 = await codeChallengeFor(v)
    expect(c1).toBe(c2)
    // RFC 7636 §4.2 — the canonical S256 example.
    expect(c1).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(c1).not.toMatch(/[+/=]/)
  })

  test('randomState produces base64url-safe values', () => {
    const s = randomState()
    expect(s).not.toMatch(/[+/=]/)
  })
})
