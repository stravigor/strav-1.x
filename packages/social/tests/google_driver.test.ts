/**
 * Slice 8.3 — Google driver against stubbed `fetch`.
 *
 * Covers:
 *   - Authorize URL with PKCE + access_type=offline + include_granted_scopes.
 *   - `offlineAccess: false` opt-out drops access_type.
 *   - `extra.hd` Workspace constraint pass-through.
 *   - `extra.prompt = consent` pass-through (apps re-establishing offline access).
 *   - Token exchange happy path.
 *   - Refresh preserves caller's refresh token (Google doesn't rotate).
 *   - UserInfo mapping with email_verified + locale + name/picture.
 *   - 401 → InvalidTokenError, 4xx → typed errors.
 *   - emailFromGoogleIdToken decode helper.
 */

import { describe, expect, test } from 'bun:test'
import {
  InvalidTokenError,
  OAuthExchangeError,
  SocialProviderError,
  StateMismatchError,
} from '../src/index.ts'
import {
  emailFromGoogleIdToken,
  GoogleSocialDriver,
} from '../src/google/index.ts'

interface StubCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeDriver(
  responder: (call: StubCall) => Response | Promise<Response>,
  opts: { offlineAccess?: boolean } = {},
): { driver: GoogleSocialDriver; calls: StubCall[] } {
  const calls: StubCall[] = []
  const stub = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
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
  const driver = new GoogleSocialDriver({
    instanceName: 'google',
    config: {
      driver: 'google',
      clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-shhh',
      ...(opts.offlineAccess !== undefined ? { offlineAccess: opts.offlineAccess } : {}),
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

describe('GoogleSocialDriver — authorize', () => {
  test('default PKCE + access_type=offline + include_granted_scopes', async () => {
    const { driver } = makeDriver(() => json({}))
    const { url, state, codeVerifier } = await driver.authorize({
      redirectUri: 'https://app.test/auth/google/cb',
    })
    const params = new URL(url).searchParams
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true)
    expect(params.get('client_id')).toBe('client.apps.googleusercontent.com')
    expect(params.get('redirect_uri')).toBe('https://app.test/auth/google/cb')
    expect(params.get('response_type')).toBe('code')
    expect(params.get('scope')).toBe('openid profile email')
    expect(params.get('state')).toBe(state)
    expect(params.get('access_type')).toBe('offline')
    expect(params.get('include_granted_scopes')).toBe('true')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(codeVerifier).toBeDefined()
  })

  test('offlineAccess: false drops access_type', async () => {
    const { driver } = makeDriver(() => json({}), { offlineAccess: false })
    const { url } = await driver.authorize({ redirectUri: 'https://app.test/cb' })
    expect(new URL(url).searchParams.has('access_type')).toBe(false)
  })

  test('extra.hd (Workspace domain) and extra.prompt pass through', async () => {
    const { driver } = makeDriver(() => json({}))
    const { url } = await driver.authorize({
      redirectUri: 'https://app.test/cb',
      extra: { hd: 'strav.dev', prompt: 'consent' },
    })
    const params = new URL(url).searchParams
    expect(params.get('hd')).toBe('strav.dev')
    expect(params.get('prompt')).toBe('consent')
  })

  test('extra.no_pkce=1 opt-out drops PKCE without leaking the helper', async () => {
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
})

describe('GoogleSocialDriver — exchange', () => {
  test('happy path posts form body with code_verifier', async () => {
    const { driver, calls } = makeDriver((call) =>
      call.url.includes('/token')
        ? json({
            access_token: 'AT_google',
            expires_in: 3599,
            refresh_token: 'RT_google',
            id_token: 'eyJ.payload.sig',
            scope: 'openid email profile',
            token_type: 'Bearer',
          })
        : json({}, 404),
    )
    const tokens = await driver.exchange({
      code: 'code_x',
      redirectUri: 'https://app.test/cb',
      state: 's',
      expectedState: 's',
      codeVerifier: 'verifier_x',
    })
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(body.get('code_verifier')).toBe('verifier_x')
    expect(body.get('client_secret')).toBe('GOCSPX-shhh')
    expect(tokens.accessToken).toBe('AT_google')
    expect(tokens.refreshToken).toBe('RT_google')
    expect(tokens.idToken).toBe('eyJ.payload.sig')
  })

  test('state mismatch → StateMismatchError', async () => {
    const { driver, calls } = makeDriver(() => json({}))
    await expect(
      driver.exchange({
        code: 'x',
        redirectUri: 'https://app/cb',
        state: 'a',
        expectedState: 'b',
      }),
    ).rejects.toThrow(StateMismatchError)
    expect(calls.length).toBe(0)
  })

  test('400 → OAuthExchangeError', async () => {
    const { driver } = makeDriver(() => new Response('{"error":"invalid_grant"}', { status: 400 }))
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

describe('GoogleSocialDriver — profile', () => {
  test('maps userinfo fields + email + locale + emailVerified', async () => {
    const { driver, calls } = makeDriver((call) =>
      call.url.includes('/v1/userinfo')
        ? json({
            sub: '110169484474386276334',
            email: 'liva@strav.dev',
            email_verified: true,
            name: 'Liva Ramarolahy',
            given_name: 'Liva',
            family_name: 'Ramarolahy',
            picture: 'https://lh3.googleusercontent.com/avatar.jpg',
            locale: 'en',
          })
        : json({}, 404),
    )
    const p = await driver.profile('AT_google')
    expect(calls[0]?.headers.authorization).toBe('Bearer AT_google')
    expect(p.id).toBe('110169484474386276334')
    expect(p.email).toBe('liva@strav.dev')
    expect(p.emailVerified).toBe(true)
    expect(p.name).toBe('Liva Ramarolahy')
    expect(p.avatarUrl).toContain('googleusercontent.com')
    expect(p.locale).toBe('en')
    expect(p.metadata.givenName).toBe('Liva')
    expect(p.metadata.familyName).toBe('Ramarolahy')
  })

  test('401 → InvalidTokenError', async () => {
    const { driver } = makeDriver(() => json({}, 401))
    await expect(driver.profile('bad')).rejects.toThrow(InvalidTokenError)
  })

  test('5xx → SocialProviderError', async () => {
    const { driver } = makeDriver(() => json({}, 503))
    await expect(driver.profile('x')).rejects.toThrow(SocialProviderError)
  })
})

describe('GoogleSocialDriver — refresh preserves caller token', () => {
  test('keeps the supplied refresh token when response omits one (Google does not rotate)', async () => {
    const { driver } = makeDriver(() =>
      json({
        access_token: 'AT_new',
        expires_in: 3599,
        // No refresh_token on Google refresh responses.
        scope: 'openid email profile',
        token_type: 'Bearer',
      }),
    )
    const tokens = await driver.refresh({ refreshToken: 'RT_existing' })
    expect(tokens.accessToken).toBe('AT_new')
    expect(tokens.refreshToken).toBe('RT_existing')
  })

  test('400 → InvalidTokenError', async () => {
    const { driver } = makeDriver(() => json({}, 400))
    await expect(driver.refresh({ refreshToken: 'x' })).rejects.toThrow(InvalidTokenError)
  })
})

describe('GoogleSocialDriver — revoke', () => {
  test('posts token to revoke endpoint', async () => {
    const { driver, calls } = makeDriver(() => json({}))
    await driver.revoke('AT_google')
    expect(calls[0]?.url).toContain('/revoke')
    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(body.get('token')).toBe('AT_google')
  })

  test('non-OK → SocialProviderError', async () => {
    const { driver } = makeDriver(() => json({}, 502))
    await expect(driver.revoke('x')).rejects.toThrow(SocialProviderError)
  })
})

describe('emailFromGoogleIdToken', () => {
  function buildJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${header}.${body}.signature`
  }

  test('extracts email + handles missing claim + rejects malformed', () => {
    expect(emailFromGoogleIdToken(buildJwt({ email: 'a@b.co' }))).toBe('a@b.co')
    expect(emailFromGoogleIdToken(buildJwt({ sub: 'x' }))).toBeNull()
    expect(() => emailFromGoogleIdToken('not-a-jwt')).toThrow(InvalidTokenError)
  })
})

describe('GoogleSocialDriver — capabilities', () => {
  test('declares full OIDC + locale + refresh + revoke', () => {
    const { driver } = makeDriver(() => json({}))
    expect(driver.capabilities.has('openid')).toBe(true)
    expect(driver.capabilities.has('pkce.support')).toBe(true)
    expect(driver.capabilities.has('profile.email')).toBe(true)
    expect(driver.capabilities.has('profile.emailVerified')).toBe(true)
    expect(driver.capabilities.has('profile.locale')).toBe(true)
    expect(driver.capabilities.has('tokens.refresh')).toBe(true)
    expect(driver.capabilities.has('tokens.revoke')).toBe(true)
  })
})
