import { beforeEach, describe, expect, test } from 'bun:test'
import { MailTransportError, type Message, SendGridTransport } from '../src/index.ts'

interface FetchCall {
  url: string
  init: RequestInit
}

interface FetchStub {
  calls: FetchCall[]
  fetch: typeof fetch
  reply(status: number, body?: unknown): void
  rejectWith(err: unknown): void
}

function makeFetchStub(): FetchStub {
  const calls: FetchCall[] = []
  let next: { status: number; body?: unknown } | { error: unknown } = { status: 202 }
  const stub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    if ('error' in next) throw next.error
    const { status, body } = next
    const text = body === undefined ? '' : JSON.stringify(body)
    return new Response(text || null, {
      status,
      statusText: status === 202 ? 'Accepted' : 'Error',
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
    from: { email: 'noreply@acme.com', name: 'Acme' },
    subject: 'Hello',
    text: 'Hi',
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SendGridTransport — golden path', () => {
  let stub: FetchStub
  let transport: SendGridTransport

  beforeEach(() => {
    stub = makeFetchStub()
    transport = new SendGridTransport({ apiKey: 'SG.test', fetch: stub.fetch })
  })

  test('POSTs to /v3/mail/send with Bearer auth + JSON body', async () => {
    await transport.send(basicMessage())
    expect(stub.calls.length).toBe(1)
    const call = stub.calls[0]
    expect(call?.url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer SG.test')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(call?.init.body as string)
    expect(body.from).toEqual({ email: 'noreply@acme.com', name: 'Acme' })
    expect(body.personalizations).toEqual([{ to: [{ email: 'alice@example.com' }] }])
    expect(body.subject).toBe('Hello')
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Hi' }])
  })

  test('text + html content ordered text/plain first', async () => {
    await transport.send({ ...basicMessage(), html: '<p>Hi</p>' })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'Hi' },
      { type: 'text/html', value: '<p>Hi</p>' },
    ])
  })

  test('cc / bcc / replyTo + structured recipients', async () => {
    await transport.send({
      to: [{ email: 'a@x', name: 'A' }, 'b@x'],
      from: { email: 'noreply@acme.com', name: 'Acme' },
      cc: 'c@x',
      bcc: ['d@x', { email: 'e@x', name: 'E' }],
      replyTo: { email: 'support@acme.com', name: 'Support' },
      subject: 's',
      text: 't',
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.personalizations).toEqual([
      {
        to: [{ email: 'a@x', name: 'A' }, { email: 'b@x' }],
        cc: [{ email: 'c@x' }],
        bcc: [{ email: 'd@x' }, { email: 'e@x', name: 'E' }],
      },
    ])
    expect(body.reply_to).toEqual({ email: 'support@acme.com', name: 'Support' })
  })

  test('attachments encode to base64 with disposition:attachment', async () => {
    await transport.send({
      ...basicMessage(),
      attachments: [{ filename: 'a.txt', content: 'hello', contentType: 'text/plain' }],
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.attachments).toEqual([
      {
        content: btoa('hello'),
        filename: 'a.txt',
        type: 'text/plain',
        disposition: 'attachment',
      },
    ])
  })

  test('endpoint override is honored + trailing slash stripped', async () => {
    const transport2 = new SendGridTransport({
      apiKey: 'SG',
      endpoint: 'https://eu.api.sendgrid.com/',
      fetch: stub.fetch,
    })
    await transport2.send(basicMessage())
    expect(stub.calls[0]?.url).toBe('https://eu.api.sendgrid.com/v3/mail/send')
  })

  test('headers pass through', async () => {
    await transport.send({
      ...basicMessage(),
      headers: { 'X-Smoke-Test': '1' },
    })
    const body = JSON.parse(stub.calls[0]?.init.body as string)
    expect(body.headers).toEqual({ 'X-Smoke-Test': '1' })
  })
})

describe('SendGridTransport — failure paths', () => {
  let stub: FetchStub
  let transport: SendGridTransport

  beforeEach(() => {
    stub = makeFetchStub()
    transport = new SendGridTransport({ apiKey: 'SG.test', fetch: stub.fetch })
  })

  test('4xx — throws MailTransportError + parsed body + retryable:false', async () => {
    stub.reply(400, { errors: [{ message: 'invalid from' }] })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      const e = err as MailTransportError
      expect(e).toBeInstanceOf(MailTransportError)
      expect(e.context.provider).toBe('sendgrid')
      expect(e.context.status).toBe(400)
      expect(e.context.retryable).toBe(false)
      expect(e.context.providerError).toEqual({ errors: [{ message: 'invalid from' }] })
    }
  })

  test('503 — retryable:true', async () => {
    stub.reply(503, { message: 'try later' })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect((err as MailTransportError).context.retryable).toBe(true)
    }
  })

  test('network failure wraps as MailTransportError with cause + retryable:true', async () => {
    const networkErr = new Error('DNS')
    stub.rejectWith(networkErr)
    try {
      await transport.send(basicMessage())
    } catch (err) {
      const e = err as MailTransportError
      expect(e).toBeInstanceOf(MailTransportError)
      expect(e.context.retryable).toBe(true)
      expect(e.cause).toBe(networkErr)
    }
  })

  test('missing `from` rejects without contacting SendGrid', async () => {
    const m: Message = { to: 'a@x', subject: 's', text: 't' }
    await expect(transport.send(m)).rejects.toThrow(/requires `from`/)
    expect(stub.calls.length).toBe(0)
  })

  test('missing both html + text rejects', async () => {
    const m: Message = { to: 'a@x', from: 'b@x', subject: 's' }
    await expect(transport.send(m)).rejects.toThrow(/at least one of/)
    expect(stub.calls.length).toBe(0)
  })
})
