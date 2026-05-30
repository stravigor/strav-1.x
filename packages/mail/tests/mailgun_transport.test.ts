import { beforeEach, describe, expect, test } from 'bun:test'
import { MailgunTransport, MailTransportError, type Message } from '../src/index.ts'

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
    body: { id: '<mg-id@example.com>' },
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
    from: 'noreply@acme.com',
    subject: 'Hello',
    text: 'Hi',
  }
}

/**
 * `FormData` is enumerable; turn it into a simple key→string map for
 * easy assertion. File parts are surfaced as `File` / `Blob` values —
 * the helper preserves them so attachment tests can read bytes.
 */
function readForm(form: FormData): {
  fields: Record<string, string>
  multi: Record<string, string[]>
  files: Array<{ field: string; filename: string; type: string; blob: Blob }>
} {
  const fields: Record<string, string> = {}
  const multi: Record<string, string[]> = {}
  const files: Array<{ field: string; filename: string; type: string; blob: Blob }> = []
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      if (key in fields) {
        if (!(key in multi)) multi[key] = [fields[key] as string]
        multi[key]?.push(value)
      } else {
        fields[key] = value
      }
    } else {
      // File / Blob
      const file = value as File
      files.push({ field: key, filename: file.name, type: file.type, blob: file })
    }
  }
  return { fields, multi, files }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('MailgunTransport — golden path', () => {
  let stub: FetchStub
  let transport: MailgunTransport

  beforeEach(() => {
    stub = makeFetchStub()
    transport = new MailgunTransport({
      apiKey: 'key-test',
      domain: 'mg.acme.com',
      fetch: stub.fetch,
    })
  })

  test('POSTs to /v3/{domain}/messages with Basic auth + FormData body', async () => {
    await transport.send(basicMessage())
    expect(stub.calls.length).toBe(1)
    const call = stub.calls[0]
    expect(call?.url).toBe('https://api.mailgun.net/v3/mg.acme.com/messages')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${btoa('api:key-test')}`)
    // fetch auto-sets the multipart content-type with boundary — we don't set one.
    expect(headers['content-type']).toBeUndefined()
    const body = call?.init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    const { fields } = readForm(body)
    expect(fields.from).toBe('noreply@acme.com')
    expect(fields.to).toBe('alice@example.com')
    expect(fields.subject).toBe('Hello')
    expect(fields.text).toBe('Hi')
  })

  test('endpoint override + trailing slash strip (EU region)', async () => {
    const transport2 = new MailgunTransport({
      apiKey: 'k',
      domain: 'mg.acme.com',
      endpoint: 'https://api.eu.mailgun.net/',
      fetch: stub.fetch,
    })
    await transport2.send(basicMessage())
    expect(stub.calls[0]?.url).toBe('https://api.eu.mailgun.net/v3/mg.acme.com/messages')
  })

  test('structured recipients render as "Name <email>"; multiple TO comma-joined', async () => {
    await transport.send({
      to: [{ email: 'a@x', name: 'Alice' }, 'b@x'],
      from: { email: 'noreply@acme.com', name: 'Acme' },
      subject: 's',
      text: 't',
    })
    const { fields } = readForm(stub.calls[0]?.init.body as FormData)
    expect(fields.from).toBe('"Acme" <noreply@acme.com>')
    expect(fields.to).toBe('"Alice" <a@x>, b@x')
  })

  test('cc + bcc are comma-joined', async () => {
    await transport.send({
      ...basicMessage(),
      cc: ['c1@x', { email: 'c2@x', name: 'C2' }],
      bcc: 'b1@x',
    })
    const { fields } = readForm(stub.calls[0]?.init.body as FormData)
    expect(fields.cc).toBe('c1@x, "C2" <c2@x>')
    expect(fields.bcc).toBe('b1@x')
  })

  test('replyTo lands on h:Reply-To form field (comma-joined for multiple)', async () => {
    await transport.send({ ...basicMessage(), replyTo: 'support@acme.com' })
    let body = readForm(stub.calls[0]?.init.body as FormData)
    expect(body.fields['h:Reply-To']).toBe('support@acme.com')

    stub.calls.length = 0
    await transport.send({ ...basicMessage(), replyTo: ['a@x', 'b@x'] })
    body = readForm(stub.calls[0]?.init.body as FormData)
    expect(body.fields['h:Reply-To']).toBe('a@x, b@x')
  })

  test('custom headers ride as h:X-… form fields', async () => {
    await transport.send({
      ...basicMessage(),
      headers: { 'X-Entity-Ref-ID': 'abc-123', 'X-Mailer': 'strav' },
    })
    const { fields } = readForm(stub.calls[0]?.init.body as FormData)
    expect(fields['h:X-Entity-Ref-ID']).toBe('abc-123')
    expect(fields['h:X-Mailer']).toBe('strav')
  })

  test('html + text both pass through when both set', async () => {
    await transport.send({ ...basicMessage(), html: '<p>Hi</p>' })
    const { fields } = readForm(stub.calls[0]?.init.body as FormData)
    expect(fields.text).toBe('Hi')
    expect(fields.html).toBe('<p>Hi</p>')
  })

  test('attachments — string content lands as a Blob part with the right type + filename', async () => {
    await transport.send({
      ...basicMessage(),
      attachments: [{ filename: 'note.txt', content: 'hello', contentType: 'text/plain' }],
    })
    const { files } = readForm(stub.calls[0]?.init.body as FormData)
    expect(files).toHaveLength(1)
    const f = files[0]
    expect(f?.field).toBe('attachment')
    expect(f?.filename).toBe('note.txt')
    // Bun's Blob constructor may append `;charset=utf-8` for text MIME types.
    // Assert prefix-match so the test is portable across runtime quirks.
    expect(f?.type.startsWith('text/plain')).toBe(true)
    expect(await f?.blob.text()).toBe('hello')
  })

  test('attachments — Uint8Array bytes preserved verbatim', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await transport.send({
      ...basicMessage(),
      attachments: [{ filename: 'bin.dat', content: bytes }],
    })
    const { files } = readForm(stub.calls[0]?.init.body as FormData)
    expect(files).toHaveLength(1)
    expect(files[0]?.type).toBe('application/octet-stream')
    const got = new Uint8Array(await (files[0]?.blob.arrayBuffer() as Promise<ArrayBuffer>))
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5])
  })

  test('attachments — base64-encoded string is decoded to bytes on the wire', async () => {
    // base64('hello') = 'aGVsbG8='
    await transport.send({
      ...basicMessage(),
      attachments: [
        { filename: 'b64.txt', content: 'aGVsbG8=', encoding: 'base64', contentType: 'text/plain' },
      ],
    })
    const { files } = readForm(stub.calls[0]?.init.body as FormData)
    expect(await files[0]?.blob.text()).toBe('hello')
  })

  test('multiple attachments — each becomes its own form part', async () => {
    await transport.send({
      ...basicMessage(),
      attachments: [
        { filename: 'a.txt', content: 'A' },
        { filename: 'b.txt', content: 'B' },
      ],
    })
    const { files } = readForm(stub.calls[0]?.init.body as FormData)
    expect(files).toHaveLength(2)
    expect(files[0]?.filename).toBe('a.txt')
    expect(files[1]?.filename).toBe('b.txt')
  })
})

describe('MailgunTransport — failure paths', () => {
  let stub: FetchStub
  let transport: MailgunTransport

  beforeEach(() => {
    stub = makeFetchStub()
    transport = new MailgunTransport({
      apiKey: 'key-test',
      domain: 'mg.acme.com',
      fetch: stub.fetch,
    })
  })

  test('4xx — throws MailTransportError with retryable:false + parsed body', async () => {
    stub.reply(401, { message: 'unauthorized' })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      const e = err as MailTransportError
      expect(e).toBeInstanceOf(MailTransportError)
      expect(e.context.provider).toBe('mailgun')
      expect(e.context.status).toBe(401)
      expect(e.context.retryable).toBe(false)
      expect(e.context.providerError).toEqual({ message: 'unauthorized' })
    }
  })

  test('429 — retryable:true', async () => {
    stub.reply(429, { message: 'rate limited' })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect((err as MailTransportError).context.retryable).toBe(true)
      expect((err as MailTransportError).context.status).toBe(429)
    }
  })

  test('502 — retryable:true', async () => {
    stub.reply(502, { message: 'bad gateway' })
    try {
      await transport.send(basicMessage())
    } catch (err) {
      expect((err as MailTransportError).context.retryable).toBe(true)
    }
  })

  test('network failure wraps as MailTransportError with cause + retryable:true', async () => {
    const networkErr = new Error('ECONNREFUSED')
    stub.rejectWith(networkErr)
    try {
      await transport.send(basicMessage())
    } catch (err) {
      const e = err as MailTransportError
      expect(e).toBeInstanceOf(MailTransportError)
      expect(e.context.provider).toBe('mailgun')
      expect(e.context.retryable).toBe(true)
      expect(e.cause).toBe(networkErr)
    }
  })

  test('missing `from` rejects without contacting Mailgun', async () => {
    const m: Message = { to: 'a@x', subject: 's', text: 't' }
    await expect(transport.send(m)).rejects.toThrow(/requires `from`/)
    expect(stub.calls.length).toBe(0)
  })
})
