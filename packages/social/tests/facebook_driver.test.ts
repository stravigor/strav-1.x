/**
 * Slice 8.4 — Facebook driver against stubbed `fetch`.
 *
 * Covers:
 *   - Authorize URL composition (no openid, comma-joined scope).
 *   - PKCE default-on + opt-out.
 *   - Token exchange happy path + state mismatch + 400.
 *   - Profile mapping (Graph `me` → SocialProfile incl. picture flattening).
 *   - 400 → InvalidTokenError (Facebook returns 400 for revoked tokens).
 *   - refresh() throws ProviderUnsupportedError (no refresh tokens).
 *   - exchangeForLongLivedToken happy path.
 *   - revoke() issues DELETE /me/permissions.
 *   - debugToken() composes app-token correctly (client_id|client_secret).
 *   - Capability set: no openid, no tokens.refresh, no emailVerified.
 */

import { describe, expect, test } from 'bun:test'
import {
  InvalidTokenError,
  OAuthExchangeError,
  ProviderUnsupportedError,
  SocialProviderError,
  StateMismatchError,
} from '../src/index.ts'
import { FacebookSocialDriver } from '../src/drivers/facebook/index.ts'

interface StubCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeDriver(
  responder: (call: StubCall) => Response | Promise<Response>,
  opts: { graphVersion?: string } = {},
): { driver: FacebookSocialDriver; calls: StubCall[] } {
  const calls: StubCall[] = []
  const stub = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v
    const body = init?.body
    const call: StubCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      ...(body !== undefined && body !== null
        ? { body: body instanceof URLSearchParams ? body.toString() : String(body) }
        : {}),
    }
    calls.push(call)
    return responder(call)
  }) as unknown as typeof fetch

  const driver = new FacebookSocialDriver({
    instanceName: 'facebook',
    config: {
      driver: 'facebook',
      clientId: '1234567890',
      clientSecret: 'fb_secret',
      ...(opts.graphVersion ? { graphVersion: opts.graphVersion } : {}),
      fetch: stub,
    },
  })
  return { driver, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('FacebookSocialDriver — authorize', () => {
  test('builds dialog URL with comma-joined scope and PKCE default-on', async () => {
    const { driver } = makeDriver(() => json({}))
    const { url, state, codeVerifier } = await driver.authorize({
      redirectUri: 'https://app.test/auth/facebook/cb',
      scopes: ['public_profile', 'email'],
    })
    expect(url.startsWith('https://www.facebook.com/v18.0/dialog/oauth?')).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('client_id')).toBe('1234567890')
    expect(params.get('response_type')).toBe('code')
    expect(params.get('scope')).toBe('public_profile,email')
    expect(params.get('state')).toBe(state)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(codeVerifier).toBeDefined()
  })

  test('graphVersion override threads into authorize URL', async () => {
    const { driver } = makeDriver(() => json({}), { graphVersion: 'v22.0' })
    const { url } = await driver.authorize({ redirectUri: 'https://app/cb' })
    expect(url.startsWith('https://www.facebook.com/v22.0/dialog/oauth?')).toBe(true)
  })

  test('PKCE opt-out via extra.no_pkce', async () => {
    const { driver } = makeDriver(() => json({}))
    const { url, codeVerifier } = await driver.authorize({
      redirectUri: 'https://app/cb',
      extra: { no_pkce: '1' },
    })
    const params = new URL(url).searchParams
    expect(codeVerifier).toBeUndefined()
    expect(params.has('code_challenge')).toBe(false)
    expect(params.has('no_pkce')).toBe(false)
  })
})

describe('FacebookSocialDriver — exchange', () => {
  test('posts form body to oauth/access_token + maps tokens', async () => {
    const { driver, calls } = makeDriver((c) =>
      c.url.includes('/oauth/access_token')
        ? json({
            access_token: 'EAA_fb_token',
            expires_in: 5183999,
            token_type: 'bearer',
          })
        : json({}, 404),
    )
    const tokens = await driver.exchange({
      code: 'fb_code',
      redirectUri: 'https://app/cb',
      state: 's',
      expectedState: 's',
      codeVerifier: 'verifier_x',
    })
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(body.get('client_id')).toBe('1234567890')
    expect(body.get('client_secret')).toBe('fb_secret')
    expect(body.get('code_verifier')).toBe('verifier_x')
    expect(tokens.accessToken).toBe('EAA_fb_token')
    expect(tokens.tokenType).toBe('bearer')
    expect(tokens.expiresAt).toBeInstanceOf(Date)
  })

  test('state mismatch → StateMismatchError', async () => {
    const { driver, calls } = makeDriver(() => json({}))
    await expect(
      driver.exchange({ code: 'x', redirectUri: 'https://app/cb', state: 'a', expectedState: 'b' }),
    ).rejects.toThrow(StateMismatchError)
    expect(calls.length).toBe(0)
  })

  test('400 from token endpoint → OAuthExchangeError', async () => {
    const { driver } = makeDriver(() => new Response('{"error":"x"}', { status: 400 }))
    await expect(
      driver.exchange({
        code: 'x',
        redirectUri: 'https://app/cb',
        state: 's',
        expectedState: 's',
      }),
    ).rejects.toThrow(OAuthExchangeError)
  })
})

describe('FacebookSocialDriver — profile', () => {
  test('maps /me response incl. flattened picture and locale + metadata', async () => {
    const { driver, calls } = makeDriver((c) =>
      c.url.includes('/me?')
        ? json({
            id: '10157000000000000',
            name: 'Liva Ramarolahy',
            email: 'liva@strav.dev',
            first_name: 'Liva',
            last_name: 'Ramarolahy',
            picture: {
              data: {
                url: 'https://scontent.xx.fbcdn.net/avatar.jpg',
                is_silhouette: false,
              },
            },
            locale: 'en_US',
          })
        : json({}, 404),
    )
    const p = await driver.profile('EAA_fb_token')
    const url = calls[0]?.url ?? ''
    expect(url).toContain('access_token=EAA_fb_token')
    expect(url).toContain('fields=')
    expect(p.id).toBe('10157000000000000')
    expect(p.provider).toBe('facebook')
    expect(p.email).toBe('liva@strav.dev')
    expect(p.name).toBe('Liva Ramarolahy')
    expect(p.avatarUrl).toContain('fbcdn.net')
    expect(p.locale).toBe('en_US')
    expect(p.metadata.firstName).toBe('Liva')
    expect(p.metadata.lastName).toBe('Ramarolahy')
    // No emailVerified — Facebook doesn't assert it.
    expect(p.emailVerified).toBeUndefined()
  })

  test('400 → InvalidTokenError (Facebook returns 400 for revoked tokens)', async () => {
    const { driver } = makeDriver(() => json({}, 400))
    await expect(driver.profile('revoked')).rejects.toThrow(InvalidTokenError)
  })

  test('5xx → SocialProviderError', async () => {
    const { driver } = makeDriver(() => json({}, 503))
    await expect(driver.profile('x')).rejects.toThrow(SocialProviderError)
  })
})

describe('FacebookSocialDriver — refresh / long-lived exchange', () => {
  test('refresh throws ProviderUnsupportedError synchronously (matches other drivers)', () => {
    const { driver } = makeDriver(() => json({}))
    expect(() => driver.refresh({ refreshToken: 'x' })).toThrow(ProviderUnsupportedError)
  })

  test('exchangeForLongLivedToken posts grant_type=fb_exchange_token', async () => {
    const { driver, calls } = makeDriver(() =>
      json({
        access_token: 'EAA_long_lived',
        expires_in: 5183999,
        token_type: 'bearer',
      }),
    )
    const tokens = await driver.exchangeForLongLivedToken('EAA_short')
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(body.get('grant_type')).toBe('fb_exchange_token')
    expect(body.get('fb_exchange_token')).toBe('EAA_short')
    expect(tokens.accessToken).toBe('EAA_long_lived')
  })

  test('exchangeForLongLivedToken 400 → InvalidTokenError', async () => {
    const { driver } = makeDriver(() => json({}, 400))
    await expect(driver.exchangeForLongLivedToken('bad')).rejects.toThrow(InvalidTokenError)
  })
})

describe('FacebookSocialDriver — revoke', () => {
  test('DELETEs /me/permissions with access_token query', async () => {
    const { driver, calls } = makeDriver(() => json({ success: true }))
    await driver.revoke('EAA_fb_token')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toContain('/me/permissions')
    expect(calls[0]?.url).toContain('access_token=EAA_fb_token')
  })

  test('non-OK → SocialProviderError', async () => {
    const { driver } = makeDriver(() => json({}, 502))
    await expect(driver.revoke('x')).rejects.toThrow(SocialProviderError)
  })
})

describe('FacebookSocialDriver — debugToken', () => {
  test('uses app-token (client_id|client_secret) for access_token', async () => {
    const { driver, calls } = makeDriver(() =>
      json({
        data: {
          user_id: '10157000000000000',
          app_id: '1234567890',
          is_valid: true,
          expires_at: 1_800_000_000,
          scopes: ['public_profile', 'email'],
        },
      }),
    )
    const result = await driver.debugToken('EAA_user_token')
    const url = calls[0]?.url ?? ''
    expect(url).toContain('input_token=EAA_user_token')
    expect(url).toContain(encodeURIComponent('1234567890|fb_secret'))
    expect(result.data?.is_valid).toBe(true)
  })
})

describe('FacebookSocialDriver — capabilities', () => {
  test('declares plain-OAuth2 set: no openid, no tokens.refresh, no emailVerified', () => {
    const { driver } = makeDriver(() => json({}))
    expect(driver.capabilities.has('pkce.support')).toBe(true)
    expect(driver.capabilities.has('profile.email')).toBe(true)
    expect(driver.capabilities.has('profile.locale')).toBe(true)
    expect(driver.capabilities.has('tokens.exchange')).toBe(true)
    expect(driver.capabilities.has('tokens.revoke')).toBe(true)
    expect(driver.capabilities.has('tokens.introspect')).toBe(true)
    // Honest gaps:
    expect(driver.capabilities.has('openid')).toBe(false)
    expect(driver.capabilities.has('tokens.refresh')).toBe(false)
    expect(driver.capabilities.has('profile.emailVerified')).toBe(false)
  })
})
