import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  AlibabaDmTransport,
  type AlibabaDmTransportOptions,
  MailTransportError,
  type Message,
} from '../src/index.ts'

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
  let next: { status: number; body?: unknown } | { error: unknown } = {
    status: 200,
    body: { RequestId: 'rid-1', EnvId: 'env-1' },
  }
  const stub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    if ('error' in next) throw next.error
    const { status, body } = next
    const text = body === undefined ? '' : JSON.stringify(body)
    return new Response(text, {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
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
    from: { email: 'noreply@acme.cn', name: 'Acme' },
    subject: 'Hello',
    text: 'Hi',
  }
}

const FIXED_NOW = new Date('2025-01-15T08:30:00Z')
const FIXED_NONCE = 'nonce-1234'

function makeTransport(
  fetchFn: typeof fetch,
  overrides: Partial<AlibabaDmTransportOptions> = {},
): AlibabaDmTransport {
  return new AlibabaDmTransport({
    accessKeyId: 'AK_TEST',
    accessKeySecret: 'AK_SECRET',
    accountName: 'noreply@acme.cn',
    fetch: fetchFn,
    now: () => FIXED_NOW,
    nonce: () => FIXED_NONCE,
    ...overrides,
  })
}

/** Parse the form-urlencoded body the transport sends. */
function parseFormBody(init: RequestInit): URLSearchParams {
  const body = init.body
  if (typeof body !== 'string') throw new Error('expected form-urlencoded string body')
  // URLSearchParams happens to handle Alibaba's encoding identically for
  // round-trip — `+` for space etc. — which is fine for assertions on
  // field values. Signature verification (which is order-sensitive) we
  // re-derive from the canonicalised params.
  return new URLSearchParams(body)
}

/** Re-derive the RPC v1 signature from the params the transport sent. */
function expectedSignature(params: URLSearchParams, accessKeySecret: string): string {
  const all = [...params.entries()].filter(([k]) => k !== 'Signature')
  const sorted = all.sort(([a], [b]) => a.localeCompare(b))
  const pct = (s: string): string =>
    encodeURIComponent(s)
      .replace(/!/g, '%21')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A')
  const canonical = sorted.map(([k, v]) => `${pct(k)}=${pct(v)}`).join('&')
  const stringToSign = `POST&${pct('/')}&${pct(canonical)}`
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64')
}

describe('AlibabaDmTransport', () => {
  test('sends a minimal text message with the expected RPC params', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await transport.send(basicMessage())

    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]!
    expect(call.url).toBe('https://dm.aliyuncs.com')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )

    const form = parseFormBody(call.init)
    expect(form.get('Action')).toBe('SingleSendMail')
    expect(form.get('Version')).toBe('2015-11-23')
    expect(form.get('Format')).toBe('JSON')
    expect(form.get('AccessKeyId')).toBe('AK_TEST')
    expect(form.get('SignatureMethod')).toBe('HMAC-SHA1')
    expect(form.get('SignatureVersion')).toBe('1.0')
    expect(form.get('SignatureNonce')).toBe(FIXED_NONCE)
    expect(form.get('Timestamp')).toBe('2025-01-15T08:30:00Z')
    expect(form.get('AccountName')).toBe('noreply@acme.cn')
    expect(form.get('AddressType')).toBe('1')
    expect(form.get('ReplyToAddress')).toBe('false')
    expect(form.get('ToAddress')).toBe('alice@example.com')
    expect(form.get('Subject')).toBe('Hello')
    expect(form.get('TextBody')).toBe('Hi')
    expect(form.get('FromAlias')).toBe('Acme')
    expect(form.get('ClickTrace')).toBe('0')
  })

  test('signature matches the RPC v1 spec for the canonical params', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await transport.send(basicMessage())

    const form = parseFormBody(stub.calls[0]!.init)
    const signature = form.get('Signature')
    expect(signature).not.toBeNull()
    expect(signature).toBe(expectedSignature(form, 'AK_SECRET'))
  })

  test('signature changes when AccessKeySecret changes', async () => {
    const stubA = makeFetchStub()
    const stubB = makeFetchStub()
    await makeTransport(stubA.fetch).send(basicMessage())
    await makeTransport(stubB.fetch, { accessKeySecret: 'OTHER' }).send(basicMessage())

    const sigA = parseFormBody(stubA.calls[0]!.init).get('Signature')
    const sigB = parseFormBody(stubB.calls[0]!.init).get('Signature')
    expect(sigA).not.toBe(sigB)
  })

  test('joins multiple ToAddress recipients with a comma', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)
    const message: Message = {
      ...basicMessage(),
      to: ['a@example.com', { email: 'b@example.com', name: 'B' }],
    }

    await transport.send(message)

    const form = parseFormBody(stub.calls[0]!.init)
    expect(form.get('ToAddress')).toBe('a@example.com,b@example.com')
  })

  test('emits both HtmlBody and TextBody when both are set', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await transport.send({ ...basicMessage(), html: '<p>Hi</p>' })

    const form = parseFormBody(stub.calls[0]!.init)
    expect(form.get('HtmlBody')).toBe('<p>Hi</p>')
    expect(form.get('TextBody')).toBe('Hi')
  })

  test('populates ReplyAddress + alias when replyTo is set', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await transport.send({
      ...basicMessage(),
      replyTo: { email: 'reply@acme.cn', name: 'Support' },
    })

    const form = parseFormBody(stub.calls[0]!.init)
    expect(form.get('ReplyToAddress')).toBe('true')
    expect(form.get('ReplyAddress')).toBe('reply@acme.cn')
    expect(form.get('ReplyAddressAlias')).toBe('Support')
  })

  test('includes TagName and ClickTrace when configured', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch, { tagName: 'welcome', clickTrace: true })

    await transport.send(basicMessage())

    const form = parseFormBody(stub.calls[0]!.init)
    expect(form.get('TagName')).toBe('welcome')
    expect(form.get('ClickTrace')).toBe('1')
  })

  test('routes to a region endpoint override (Singapore)', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch, {
      endpoint: 'https://dm.ap-southeast-1.aliyuncs.com',
    })

    await transport.send(basicMessage())

    expect(stub.calls[0]!.url).toBe('https://dm.ap-southeast-1.aliyuncs.com')
  })

  test('strips trailing slash from endpoint', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch, {
      endpoint: 'https://dm.ap-southeast-5.aliyuncs.com/',
    })

    await transport.send(basicMessage())

    expect(stub.calls[0]!.url).toBe('https://dm.ap-southeast-5.aliyuncs.com')
  })

  test('throws when message has no `from`', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)
    const message = { to: 'a@example.com', subject: 'x', text: 'y' } as Message

    await expect(transport.send(message)).rejects.toBeInstanceOf(MailTransportError)
    expect(stub.calls).toHaveLength(0)
  })

  test('throws on cc — DM SingleSendMail has no cc parameter', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await expect(
      transport.send({ ...basicMessage(), cc: 'cc@example.com' }),
    ).rejects.toBeInstanceOf(MailTransportError)
    expect(stub.calls).toHaveLength(0)
  })

  test('throws on bcc — same reason as cc', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await expect(
      transport.send({ ...basicMessage(), bcc: 'bcc@example.com' }),
    ).rejects.toBeInstanceOf(MailTransportError)
    expect(stub.calls).toHaveLength(0)
  })

  test('throws on attachments — SingleSendMail has no attachment field', async () => {
    const stub = makeFetchStub()
    const transport = makeTransport(stub.fetch)

    await expect(
      transport.send({
        ...basicMessage(),
        attachments: [{ filename: 'a.txt', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(MailTransportError)
    expect(stub.calls).toHaveLength(0)
  })

  test('wraps a 4xx response in MailTransportError flagged non-retryable', async () => {
    const stub = makeFetchStub()
    stub.reply(400, { Code: 'InvalidParameter', Message: 'bad subject' })
    const transport = makeTransport(stub.fetch)

    let caught: unknown
    try {
      await transport.send(basicMessage())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MailTransportError)
    const err = caught as MailTransportError
    expect(err.context['status']).toBe(400)
    expect(err.context['retryable']).toBe(false)
    expect(err.context['provider']).toBe('alibaba')
    expect(err.context['providerError']).toEqual({
      Code: 'InvalidParameter',
      Message: 'bad subject',
    })
  })

  test('flags 5xx as retryable', async () => {
    const stub = makeFetchStub()
    stub.reply(503, { Code: 'ServiceUnavailable' })
    const transport = makeTransport(stub.fetch)

    let caught: unknown
    try {
      await transport.send(basicMessage())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MailTransportError)
    expect((caught as MailTransportError).context['retryable']).toBe(true)
  })

  test('flags 429 as retryable', async () => {
    const stub = makeFetchStub()
    stub.reply(429, { Code: 'Throttling' })
    const transport = makeTransport(stub.fetch)

    let caught: unknown
    try {
      await transport.send(basicMessage())
    } catch (err) {
      caught = err
    }
    expect((caught as MailTransportError).context['retryable']).toBe(true)
  })

  test('wraps a network failure as retryable', async () => {
    const stub = makeFetchStub()
    stub.rejectWith(new TypeError('connect ECONNREFUSED'))
    const transport = makeTransport(stub.fetch)

    let caught: unknown
    try {
      await transport.send(basicMessage())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MailTransportError)
    expect((caught as MailTransportError).context['retryable']).toBe(true)
  })
})
