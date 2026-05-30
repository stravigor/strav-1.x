import { describe, expect, test } from 'bun:test'
import { HttpKernel } from '@strav/http'
import { createApp } from '../../bootstrap/app.ts'
import { providers } from '../../bootstrap/providers.ts'

describe('GET /healthz', () => {
  test('returns 200 { ok: true }', async () => {
    const app = createApp()
    app.useProviders(providers())
    await app.start()

    const kernel = app.resolve(HttpKernel)
    const res = await kernel.handle(new Request('http://localhost/healthz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await app.shutdown()
  })
})
