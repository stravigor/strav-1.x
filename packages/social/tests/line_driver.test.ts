/**
 * Slice 8.2 — Line driver against a stubbed `fetch`. Verifies:
 *   - Authorize URL composition (endpoint, params, PKCE, ui_locales).
 *   - PKCE default-on / opt-out via `extra.no_pkce`.
 *   - Token exchange (form body, headers).
 *   - State mismatch + PKCE mismatch error paths.
 *   - Profile mapping (Line shapes → SocialProfile).
 *   - Refresh + revoke wiring.
 *   - 401 / 4xx → typed errors.
 *   - `emailFromLineIdToken` extracts email from a real-shape JWT.
 */

import { describe, expect, test } from 'bun:test'
import {
  InvalidTokenError,
  OAuthExchangeError,
  SocialProviderError,
  StateMismatchError,
} from '../src/index.ts'
import { emailFromLineIdToken, LineSocialDriver } from '../src/line/index.ts'

interface StubCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeDriver(responder: (call: StubCall) => Response | Promise<Response>): {
  driver: LineSocialDriver
  calls: StubCall[]
} {
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
  const driver = new LineSocialDriver({
    instanceName: 'line',
    config: {
      driver: 'line',
      clientId: '1234567890',
      clientSecret: 'shhh',
      uiLocales: 'th-TH',
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

describe('LineSocialDriver — authorize', () => {
  test('builds the standard Line authorize URL with PKCE + ui_locales', async () => {
    const { driver } = makeDriver(() => json({}))
    const { url, state, codeVerifier } = await driver.authorize({
      redirectUri: 'https://app.test/auth/line/cb',
      scopes: ['openid', 'profile', 'email'],
    })
    expect(url.startsWith('https://access.line.me/oauth2/v2.1/authorize?')).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('response_type')).toBe('code')
    expect(params.get('client_id')).toBe('1234567890')
    expect(params.get('redirect_uri')).toBe('https://app.test/auth/line/cb')
    expect(params.get('scope')).toBe('openid profile email')
    expect(params.get('state')).toBe(state)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(params.get('ui_locales')).toBe('th-TH')
    expect(codeVerifier).toBeDefined()
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('extra.no_pkce=1 opts out of PKCE without leaking the helper to Line', async () => {
    const { driver } = makeDriver(() => json({}))
    const { url, codeVerifier } = await driver.authorize({
      redirectUri: 'https://app.test/cb',
      extra: { no_pkce: '1' },
    })
    const params = new URL(url).searchParams
    expect(codeVerifier).toBeUndefined()
    expect(params.has('code_challenge')).toBe(false)
    expect(params.has('no_pkce')).toBe(false)
  })

  test('custom state pass-through', async () => {
    const { driver } = makeDriver(() => json({}))
    const out = await driver.authorize({
      redirectUri: 'https://app.test/cb',
      state: 'session_token_abc',
    })
    expect(out.state).toBe('session_token_abc')
    expect(new URL(out.url).searchParams.get('state')).toBe('session_token_abc')
  })

  test('extra params merge (Line-specific bot_prompt)', async () => {
    const { driver } = makeDriver(() => json({}))
    const out = await driver.authorize({
      redirectUri: 'https://app.test/cb',
      extra: { bot_prompt: 'aggressive' },
    })
    expect(new URL(out.url).searchParams.get('bot_prompt')).toBe('aggressive')
  })
})

describe('LineSocialDriver — exchange', () => {
  test('posts form body to token endpoint with code_verifier', async () => {
    const { driver, calls } = makeDriver((call) => {
      if (call.url.includes('/token')) {
        return json({
          access_token: 'AT_test',
          expires_in: 2592000,
          refresh_token: 'RT_test',
          id_token: 'eyJ.payload.sig',
          scope: 'openid profile email',
          token_type: 'Bearer',
        })
      }
      return json({}, 404)
    })
    const tokens = await driver.exchange({
      code: 'authcode_x',
      redirectUri: 'https://app.test/cb',
      state: 'st',
      expectedState: 'st',
      codeVerifier: 'verifier_x',
    })
    const tokenCall = calls.find((c) => c.url.includes('/token'))!
    expect(tokenCall.method).toBe('POST')
    expect(tokenCall.headers['content-type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(tokenCall.body)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('authcode_x')
    expect(body.get('client_id')).toBe('1234567890')
    expect(body.get('client_secret')).toBe('shhh')
    expect(body.get('code_verifier')).toBe('verifier_x')

    expect(tokens.accessToken).toBe('AT_test')
    expect(tokens.refreshToken).toBe('RT_test')
    expect(tokens.idToken).toBe('eyJ.payload.sig')
    expect(tokens.scope).toBe('openid profile email')
    expect(tokens.expiresAt).toBeInstanceOf(Date)
  })

  test('state mismatch → StateMismatchError without calling the API', async () => {
    const { driver, calls } = makeDriver(() => json({}))
    await expect(
      driver.exchange({
        code: 'x',
        redirectUri: 'https://app.test/cb',
        state: 'a',
        expectedState: 'b',
      }),
    ).rejects.toThrow(StateMismatchError)
    expect(calls.length).toBe(0)
  })

  test('non-OK token response → OAuthExchangeError', async () => {
    const { driver } = makeDriver(() =>
      new Response('{"error":"invalid_grant"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(
      driver.exchange({
        code: 'x',
        redirectUri: 'https://app.test/cb',
        state: 's',
        expectedState: 's',
      }),
    ).rejects.toThrow(OAuthExchangeError)
  })
})

describe('LineSocialDriver — profile', () => {
  test('GETs /v2/profile with Bearer + maps to SocialProfile', async () => {
    const { driver, calls } = makeDriver((call) => {
      if (call.url.includes('/v2/profile')) {
        return json({
          userId: 'U1234567890abcdef',
          displayName: 'Liva',
          pictureUrl: 'https://profile.line-scdn.net/avatar.jpg',
          statusMessage: 'Hello SEA',
        })
      }
      return json({}, 404)
    })
    const p = await driver.profile('AT_test')
    expect(calls[0]?.headers.authorization).toBe('Bearer AT_test')
    expect(p.id).toBe('U1234567890abcdef')
    expect(p.provider).toBe('line')
    expect(p.name).toBe('Liva')
    expect(p.avatarUrl).toContain('line-scdn.net')
    // Line does not return email on this endpoint.
    expect(p.email).toBeUndefined()
    expect(p.metadata.statusMessage).toBe('Hello SEA')
  })

  test('401 → InvalidTokenError', async () => {
    const { driver } = makeDriver(() => json({}, 401))
    await expect(driver.profile('bad')).rejects.toThrow(InvalidTokenError)
  })

  test('non-401 non-OK → SocialProviderError', async () => {
    const { driver } = makeDriver(() => json({}, 503))
    await expect(driver.profile('x')).rejects.toThrow(SocialProviderError)
  })
})

describe('LineSocialDriver — refresh + revoke', () => {
  test('refresh posts grant_type=refresh_token', async () => {
    const { driver, calls } = makeDriver(() =>
      json({
        access_token: 'AT_new',
        expires_in: 2592000,
        refresh_token: 'RT_new',
        token_type: 'Bearer',
      }),
    )
    const tokens = await driver.refresh({ refreshToken: 'RT_old' })
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT_old')
    expect(tokens.accessToken).toBe('AT_new')
  })

  test('refresh 400 → InvalidTokenError', async () => {
    const { driver } = makeDriver(() => json({}, 400))
    await expect(driver.refresh({ refreshToken: 'x' })).rejects.toThrow(InvalidTokenError)
  })

  test('revoke posts access_token + credentials', async () => {
    const { driver, calls } = makeDriver(() => json({}))
    await driver.revoke('AT_test')
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(calls[0]?.url).toContain('/revoke')
    expect(body.get('access_token')).toBe('AT_test')
    expect(body.get('client_id')).toBe('1234567890')
  })
})

describe('emailFromLineIdToken', () => {
  function buildJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${header}.${body}.signature`
  }

  test('extracts email when present', () => {
    expect(emailFromLineIdToken(buildJwt({ sub: 'U1', email: 'a@b.co' }))).toBe('a@b.co')
  })

  test('returns null when email claim missing', () => {
    expect(emailFromLineIdToken(buildJwt({ sub: 'U1' }))).toBeNull()
  })

  test('throws on malformed id_token', () => {
    expect(() => emailFromLineIdToken('not-a-jwt')).toThrow(InvalidTokenError)
  })
})

describe('LineSocialDriver — capabilities', () => {
  test('declares openid + pkce.support + tokens.refresh + email', () => {
    const { driver } = makeDriver(() => json({}))
    expect(driver.capabilities.has('openid')).toBe(true)
    expect(driver.capabilities.has('pkce.support')).toBe(true)
    expect(driver.capabilities.has('profile.email')).toBe(true)
    expect(driver.capabilities.has('tokens.refresh')).toBe(true)
    expect(driver.capabilities.has('tokens.revoke')).toBe(true)
    // No locale on the profile API.
    expect(driver.capabilities.has('profile.locale')).toBe(false)
  })
})
