import { describe, expect, test } from 'bun:test'
import { stubFetch } from '../src/stub_fetch.ts'

describe('stubFetch', () => {
  test('returns the handler response for URL+init calls', async () => {
    const fetch = stubFetch(async (req) => {
      expect(req.url).toBe('https://example.test/x')
      expect(req.method).toBe('POST')
      return Response.json({ ok: true })
    })
    const res = await fetch('https://example.test/x', { method: 'POST' })
    expect(await res.json()).toEqual({ ok: true })
  })

  test('normalizes URL objects to Request', async () => {
    const captured: string[] = []
    const fetch = stubFetch(async (req) => {
      captured.push(req.url)
      return new Response('ok')
    })
    await fetch(new URL('https://example.test/path'))
    expect(captured).toEqual(['https://example.test/path'])
  })

  test('passes Request instances through', async () => {
    const original = new Request('https://example.test/', { method: 'PATCH' })
    const fetch = stubFetch(async (req) => {
      expect(req.method).toBe('PATCH')
      return new Response('ok')
    })
    await fetch(original)
  })

  test('layers init on top of an existing Request when both are provided', async () => {
    const original = new Request('https://example.test/', { method: 'GET' })
    const fetch = stubFetch(async (req) => {
      expect(req.method).toBe('POST')
      return new Response('ok')
    })
    await fetch(original, { method: 'POST' })
  })

  test('handler can read the request body', async () => {
    const fetch = stubFetch(async (req) => {
      const body = await req.text()
      expect(body).toBe('grant_type=authorization_code')
      return new Response('ok')
    })
    await fetch('https://example.test/token', {
      method: 'POST',
      body: 'grant_type=authorization_code',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
  })
})
