/**
 * LIFF ID-token verification — mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { InstantProviderError } from '../../src/errors.ts'
import { LineLiff } from '../../src/line/line_liff.ts'

const ORIGINAL_FETCH = globalThis.fetch

function mockFetch(response: { status: number; body: unknown }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('LineLiff', () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  test('constructor rejects empty channelId', () => {
    expect(() => new LineLiff('')).toThrow(InstantProviderError)
  })

  test('verifyIdToken returns claims when LINE returns 200', async () => {
    mockFetch({
      status: 200,
      body: {
        sub: 'Uuser',
        name: 'Alice',
        picture: 'https://x/a.jpg',
        email: 'a@b.co',
        aud: '1234',
        iss: 'https://access.line.me',
        exp: 1_700_000_000,
        iat: 1_699_000_000,
      },
    })
    const liff = new LineLiff('1234')
    const claims = await liff.verifyIdToken('token')
    expect(claims).toMatchObject({
      sub: 'Uuser',
      name: 'Alice',
      email: 'a@b.co',
      aud: '1234',
    })
    expect(claims.raw.iss).toBe('https://access.line.me')
  })

  test('verifyIdToken throws on non-2xx', async () => {
    mockFetch({ status: 400, body: { error: 'invalid_request' } })
    const liff = new LineLiff('1234')
    await expect(liff.verifyIdToken('token')).rejects.toThrow(InstantProviderError)
  })
})
