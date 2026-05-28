import { beforeEach, describe, expect, test } from 'bun:test'
import { isStravError } from '@strav/kernel'
import { MailTransportError, type Message, ResendTransport } from '../src/index.ts'

interface FetchCall {
  url: string
  init: RequestInit
}

interface FetchStub {
  calls: FetchCall[]
  fetch: typeof fetch
  /** Set the next response. */
  reply(status: number, body?: unknown): void
  /** Reject the next fetch (network error). */
  rejectWith(err: unknown): void
}

function makeFetchStub(): FetchStub {
  const calls: FetchCall[] = []
  let next: { status: number; body?: unknown } | { error: unknown } = {
    status: 200,
    body: { id: 'r-1' },
  }
  const stub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    if ('error' in next) throw next.error
    const { status, body } = next
    const text = body === undefined ? '' : JSON.stringify(body)
    return new Response(text, {
      status,
      statusText: status === 200 ? 'OK' : status === 422 ? 'Unprocessable Entity' : 'Error',
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return {
    calls,
    fetch: stub,
    reply(status, body) {
      next = { status, body }
    },
    rejectWith(error) {
      next = { error }
    },
  }
}

function basicMessage(): Message {
  return {
    to: 'alice@example.com',
    from: 'noreply@acme.com',
    subject: 'Hello',
    text: 'Hi',
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('ResendTransport — golden path', () => {
  let stub: FetchStub
  let transport: ResendTransport

  beforeEach(() => {
    stub = makeFetchStub()
    transport = new ResendTransport({ apiKey: 'test-key', fetch: stub.fetch })
  })

  test('POSTs to /emails with Bearer auth + JSON body', async () => {
    await transport.send(basicMessage())
    expect(stub.calls.length).toBe(1)
    const call = stub.calls[0]
    expect(call?.url).toBe('https://api.resend.com/emails')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(call?.init.body as string)
    expect(body.from).toBe('noreply@acme.com')
    expect(body.to).toEqual(['alice@example.com'])
    expect(body.subject).toBe('Hello')
    expect(body.text).toBe('Hi')
  })

  test('endpoint override is honored + trailing slash stripped', async () => {
    const transport2 = new ResendTransport({
      apiKey: 'k',
      endpoint: 'https://api.example.dev/',
      fetch: stub.fetch,
    })
    await transport2.send(basicMessage())
    expect(stub.calls[0]?.url).toBe('https://api.example.dev/emails')
  })

  test('structured recipients render as "Name <email>"', async () => {
    const m: Message = {
      to: { email: 'alice@x', name: 'Alice' },
      from: { email: 'noreply@acme.com', name: 'Acme Co' },
      cc: ['bob@x', { email: 'carol@x', name: 'Carol' }],
      subject: 's',
      text: 't',
    }
    await transport.send(m)
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.from).toBe('"Acme Co" <noreply@acme.com>')
    expect(body.to).toEqual(['"Alice" <alice@x>'])
    expect(body.cc).toEqual(['bob@x', '"Carol" <carol@x>'])
  })

  test('display-name quotes are escaped', async () => {
    await transport.send({
      to: { email: 'a@x', name: 'A "quoted" Name' },
      from: 'noreply@acme.com',
      subject: 's',
      text: 't',
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.to).toEqual(['"A \\"quoted\\" Name" <a@x>'])
  })

  test('attachments encode to base64 with optional content_type', async () => {
    await transport.send({
      ...basicMessage(),
      attachments: [
        { filename: 'a.txt', content: 'hello' },
        {
          filename: 'b.bin',
          content: new Uint8Array([1, 2, 3]),
          contentType: 'application/octet-stream',
        },
        { filename: 'c.b64', content: 'aGVsbG8=', encoding: 'base64' },
      ],
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.attachments).toEqual([
      { filename: 'a.txt', content: btoa('hello') },
      {
        filename: 'b.bin',
        content: btoa(String.fromCharCode(1, 2, 3)),
        content_type: 'application/octet-stream',
      },
      { filename: 'c.b64', content: 'aGVsbG8=' },
    ])
  })

  test('headers + replyTo pass through (single replyTo collapses to string)', async () => {
    await transport.send({
      ...basicMessage(),
      replyTo: 'support@acme.com',
      headers: { 'X-Entity-Ref-ID': 'abc-123' },
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.headers).toEqual({ 'X-Entity-Ref-ID': 'abc-123' })
    expect(body.reply_to).toBe('support@acme.com')
  })

  test('list of replyTo passes as array', async () => {
    await transport.send({
      ...basicMessage(),
      replyTo: ['a@x', 'b@x'],
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.reply_to).toEqual(['a@x', 'b@x'])
  })
})

describe('ResendTransport — failure paths', () => {
  let stub: FetchStub
  let transport: ResendTransport

  beforeEach(() => {
    stub = makeFetchStub()
    transport = new ResendTransport({ apiKey: 'test-key', fetch: stub.fetch })
  })

  test('4xx — throws MailTransportError with retryable:false + parsed body', async () => {
    stub.reply(422, { name: 'validation_error', message: 'invalid to' })
    await expect(transport.send(basicMessage())).rejects.toThrow(MailTransportError)
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect(isStravError(err)).toBe(true)
      const ctx = (err as MailTransportError).context
      expect(ctx.provider).toBe('resend')
      expect(ctx.status).toBe(422)
      expect(ctx.retryable).toBe(false)
      expect(ctx.providerError).toEqual({ name: 'validation_error', message: 'invalid to' })
    }
  })

  test('429 — retryable:true', async () => {
    stub.reply(429, { name: 'rate_limit' })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect((err as MailTransportError).context.retryable).toBe(true)
      expect((err as MailTransportError).context.status).toBe(429)
    }
  })

  test('500 — retryable:true', async () => {
    stub.reply(500, { message: 'oops' })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect((err as MailTransportError).context.retryable).toBe(true)
    }
  })

  test('network failure wraps as MailTransportError with cause + retryable:true', async () => {
    const networkErr = new Error('ECONNRESET')
    stub.rejectWith(networkErr)
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect(err).toBeInstanceOf(MailTransportError)
      const e = err as MailTransportError
      expect(e.context.provider).toBe('resend')
      expect(e.context.retryable).toBe(true)
      expect(e.cause).toBe(networkErr)
    }
  })

  test('missing `from` rejects without contacting Resend', async () => {
    const m: Message = { to: 'a@x', subject: 's', text: 't' }
    await expect(transport.send(m)).rejects.toThrow(/requires `from`/)
    expect(stub.calls.length).toBe(0)
  })
})
