import { describe, expect, test } from 'bun:test'
import type { HttpContext } from '../../src/context/types.ts'
import { Router } from '../../src/router/index.ts'
import { encodeSSEEvent, type SSEEvent, sseResponse } from '../../src/sse/index.ts'

const DECODER = new TextDecoder()

async function readBody(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) throw new Error('null body')
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value !== undefined) out += DECODER.decode(value, { stream: true })
  }
  out += DECODER.decode()
  return out
}

describe('encodeSSEEvent', () => {
  test('renders data + event + id + retry', () => {
    const bytes = encodeSSEEvent({ data: 'hello', event: 'tick', id: 'e1', retry: 2000 })
    expect(DECODER.decode(bytes)).toBe('event: tick\nid: e1\nretry: 2000\ndata: hello\n\n')
  })

  test('JSON-stringifies non-string data', () => {
    const bytes = encodeSSEEvent({ data: { invoiceId: 'inv_1', amount: 4900 } })
    expect(DECODER.decode(bytes)).toBe('data: {"invoiceId":"inv_1","amount":4900}\n\n')
  })

  test('multi-line data is split into one data: line per source line', () => {
    const bytes = encodeSSEEvent({ data: 'line1\nline2\nline3' })
    expect(DECODER.decode(bytes)).toBe('data: line1\ndata: line2\ndata: line3\n\n')
  })

  test('renders comments as `:` lines', () => {
    const bytes = encodeSSEEvent({ comment: 'heartbeat' })
    expect(DECODER.decode(bytes)).toBe(': heartbeat\n\n')
  })

  test('omits absent fields', () => {
    const bytes = encodeSSEEvent({ data: 'hi' })
    expect(DECODER.decode(bytes)).toBe('data: hi\n\n')
  })
})

describe('sseResponse', () => {
  test('sets the standard SSE headers', async () => {
    async function* iter(): AsyncGenerator<SSEEvent> {
      yield { data: 'hi' }
    }
    const res = sseResponse(iter(), { heartbeatMs: 0 })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('connection')).toBe('keep-alive')
    expect(res.headers.get('x-accel-buffering')).toBe('no')

    await readBody(res.body)
  })

  test('streams every yielded event in order', async () => {
    async function* iter(): AsyncGenerator<SSEEvent> {
      yield { data: 'a', id: '1' }
      yield { data: 'b', id: '2' }
      yield { data: 'c', id: '3' }
    }
    const res = sseResponse(iter(), { heartbeatMs: 0 })
    const body = await readBody(res.body)

    expect(body).toBe('id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n')
  })

  test('allows the iterable to read async sources', async () => {
    async function* iter(): AsyncGenerator<SSEEvent> {
      await new Promise((r) => setTimeout(r, 5))
      yield { data: 'first' }
      await new Promise((r) => setTimeout(r, 5))
      yield { data: 'second' }
    }
    const res = sseResponse(iter(), { heartbeatMs: 0 })
    const body = await readBody(res.body)

    expect(body).toBe('data: first\n\ndata: second\n\n')
  })

  test('client abort calls iterator.return so generators run their finally', async () => {
    const cleanup: string[] = []

    async function* iter(): AsyncGenerator<SSEEvent> {
      try {
        let i = 0
        for (;;) {
          await new Promise((r) => setTimeout(r, 1))
          yield { data: `tick ${i++}` }
        }
      } finally {
        cleanup.push('finally ran')
      }
    }

    const controller = new AbortController()
    const res = sseResponse(iter(), { heartbeatMs: 0, signal: controller.signal })
    const reader = res.body!.getReader()

    // Consume two events, then abort.
    await reader.read()
    await reader.read()
    controller.abort()
    // Drain so the stream completes.
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      // expected — close path
    }

    // Give the close path a moment to run iterator.return().
    await new Promise((r) => setTimeout(r, 10))
    expect(cleanup).toEqual(['finally ran'])
  })

  test('emits heartbeat comments at the configured interval', async () => {
    let resolveYield: (() => void) | undefined
    const block = new Promise<void>((r) => {
      resolveYield = r
    })

    async function* iter(): AsyncGenerator<SSEEvent> {
      yield { data: 'first' }
      await block
      yield { data: 'second' }
    }
    const res = sseResponse(iter(), { heartbeatMs: 10 })
    const reader = res.body!.getReader()

    // First event arrives immediately.
    const first = await reader.read()
    expect(DECODER.decode(first.value)).toContain('data: first')

    // Within ~30ms we should see at least one heartbeat comment.
    let sawHeartbeat = false
    const start = Date.now()
    while (Date.now() - start < 80) {
      const { value, done } = await reader.read()
      if (done) break
      const text = DECODER.decode(value)
      if (text.includes(': heartbeat')) {
        sawHeartbeat = true
        break
      }
    }
    expect(sawHeartbeat).toBe(true)
    resolveYield?.()
    // Drain.
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
  })

  test('router.sse registers a GET route with a stream-bodied handler', async () => {
    const router = new Router()

    async function* ticks(_ctx: HttpContext): AsyncGenerator<SSEEvent> {
      yield { data: 'one', id: '1' }
      yield { data: 'two', id: '2' }
    }
    router.sse('/events', ticks, { heartbeatMs: 0 })

    const result = router.match('GET', '/events')
    expect(result.kind).toBe('found')
    if (result.kind !== 'found') throw new Error('unreachable')

    // Invoke the compiled handler directly with a fake ctx — the router
    // wraps it into a Response synchronously, no kernel needed here.
    const handler = result.route.handler as (ctx: HttpContext) => Promise<Response>
    const fakeRequest = new Request('http://x/events')
    const response = await handler({
      request: { raw: fakeRequest },
    } as unknown as HttpContext)

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    const body = await readBody(response.body)
    expect(body).toBe('id: 1\ndata: one\n\nid: 2\ndata: two\n\n')
  })

  test('throws-in-generator propagate as a stream error', async () => {
    async function* iter(): AsyncGenerator<SSEEvent> {
      yield { data: 'first' }
      throw new Error('boom')
    }
    const res = sseResponse(iter(), { heartbeatMs: 0 })
    const reader = res.body!.getReader()

    await reader.read() // first event
    let errored = false
    try {
      await reader.read()
    } catch {
      errored = true
    }
    expect(errored).toBe(true)
  })
})
