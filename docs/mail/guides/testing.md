# Testing mail

The framework gives you a real in-process mail layer for tests — no mocking the manager, no monkey-patching `fetch`. Configure the `array` transport as the default in test mode, then assert on the recorded messages. Inbound parsers are pure functions; feed them a request payload and assert on the parsed result.

## Wiring the array transport

`config/mail.ts` selects the default by environment:

```ts
function defaultTransport(): string {
  if (process.env.NODE_ENV === 'test') return 'array'
  if (process.env.NODE_ENV === 'production') return 'resend'
  return 'log'
}

export default {
  default: defaultTransport(),
  from: { email: 'noreply@acme.com', name: 'Acme' },
  transports: {
    array: { driver: 'array' },
    log: { driver: 'log', channel: 'mail' },
    resend: { driver: 'resend', apiKey: process.env.RESEND_API_KEY ?? '' },
  },
} satisfies MailConfig
```

In tests, `mail.send(...)` lands every send in an `ArrayTransport.messages` array. No fetch, no provider account, no flake.

## Asserting on sends

`mail.via()` returns the cached default transport. Cast it to `ArrayTransport` to read history:

```ts
import { ArrayTransport, MailManager } from '@strav/mail'
import { test, expect } from 'bun:test'

test('signup sends a welcome email', async () => {
  const { mail, signup } = await bootTestApp()

  await signup({ email: 'alice@example.com', name: 'Alice' })

  const sent = (mail.via() as ArrayTransport).messages
  expect(sent).toHaveLength(1)
  expect(sent[0]?.subject).toBe('Welcome, Alice')
  expect(sent[0]?.to).toEqual({ email: 'alice@example.com', name: 'Alice' })
})
```

`messages` is a frozen view — calling `.push()` on it doesn't mutate the transport's internal array. Between tests, call `transport.clear()` (or rebuild the container in a `beforeEach`) so one test's sends don't leak into the next.

If you use multiple named transports in production, register them in test config too — the `via('bulk')` call still needs to resolve. Make each one a separate `array` driver so you can assert on routing:

```ts
transports: {
  default: { driver: 'array' },
  bulk: { driver: 'array' },
}
```

```ts
expect((mail.via('bulk') as ArrayTransport).count).toBe(50)
expect((mail.via() as ArrayTransport).count).toBe(0)
```

## Testing Mailables

Two shapes, depending on what you're verifying.

**Verifying the built message** — call `build()` directly without going through the queue:

```ts
test('WelcomeEmail builds with the user name', async () => {
  const users = makeUserRepo({ '01J...': { email: 'a@x', name: 'Alice' } })
  const mail = makeMailManager()                 // ArrayTransport default
  const mailable = new WelcomeEmail(mail, users)

  const message = await mailable.build({ userId: '01J...' })

  expect(message.subject).toBe('Welcome, Alice')
})
```

This is the unit-test path. No queue, no DI container, no transport — just the function under test.

**Verifying dispatch-to-delivery** — go through `MailManager.send(MailableClass, payload)`:

```ts
test('WelcomeEmail goes out for a real user', async () => {
  const { mail, container } = await bootTestApp()
  await seedUser({ id: '01J...', email: 'a@x', name: 'Alice' })

  await mail.send(WelcomeEmail, { userId: '01J...' })

  const sent = (mail.via() as ArrayTransport).messages
  expect(sent[0]?.to).toEqual({ email: 'a@x', name: 'Alice' })
})
```

The sync `send(MailableClass, payload)` overload constructs the Mailable through the container, calls `build()`, calls the transport — same code path the worker takes, minus the queue hop.

**Verifying the queued path** — if you want to assert the job actually went through the queue (e.g. it has the right `jobName`, retry policy applies), dispatch onto the in-process queue and drain it:

```ts
await queue.dispatch(WelcomeEmail, { userId: '01J...' })
await worker.runOnce()                            // pop + handle one job
expect((mail.via() as ArrayTransport).count).toBe(1)
```

## Testing inbound webhook handlers

The parsers are pure — feed them a `{ body, headers }` and assert on the result. No HTTP layer, no controller.

```ts
import { PostmarkInboundParser } from '@strav/mail'

test('Postmark parser maps recipients and threading', async () => {
  const parser = new PostmarkInboundParser()

  const mail = await parser.parse({
    body: JSON.stringify({
      FromFull: { Email: 'a@x', Name: 'Alice' },
      ToFull: [{ Email: 'support@x' }],
      Subject: 'Re: ticket',
      TextBody: 'see below',
      Headers: [
        { Name: 'In-Reply-To', Value: '<parent@x>' },
        { Name: 'References', Value: '<root@x> <parent@x>' },
      ],
      Attachments: [],
    }),
    headers: { 'content-type': 'application/json' },
  })

  expect(mail.from.address).toBe('a@x')
  expect(mail.inReplyTo).toBe('parent@x')
  expect(mail.references).toEqual(['root@x', 'parent@x'])
})
```

For the Mailgun parser, you need a signed payload. Compute the HMAC inline so the test reflects the real wire format:

```ts
import { createHmac } from 'node:crypto'
import { MailgunInboundParser } from '@strav/mail'

const SIGNING_KEY = 'test-key'

async function buildSignedRequest(fields: Record<string, string>) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const token = 'a'.repeat(50)
  const signature = createHmac('sha256', SIGNING_KEY)
    .update(timestamp + token)
    .digest('hex')

  const form = new FormData()
  for (const [k, v] of Object.entries({ ...fields, timestamp, token, signature })) {
    form.set(k, v)
  }
  const res = new Response(form)
  return {
    body: Buffer.from(await res.arrayBuffer()),
    headers: { 'content-type': res.headers.get('content-type') ?? '' },
  }
}

test('Mailgun parser accepts a valid signed payload', async () => {
  const parser = new MailgunInboundParser({ webhookSigningKey: SIGNING_KEY })
  const req = await buildSignedRequest({
    sender: 'a@x',
    from: 'Alice <a@x>',
    recipient: 'support@x',
    subject: 'hi',
    'body-plain': 'hello',
    'message-headers': JSON.stringify([['Message-Id', '<abc@x>']]),
  })

  const mail = await parser.parse(req)
  expect(mail.from.name).toBe('Alice')
  expect(mail.messageId).toBe('abc@x')
})
```

For the controller-level test (route → parser → handler), drive it with a real `Request`. The parser is verified separately, so this test focuses on integration:

```ts
test('inbound mail webhook creates a ticket', async () => {
  const { app, tickets } = await bootTestApp()
  const req = await buildSignedRequest({ /* ... */ })

  const res = await app.fetch(new Request('http://x/webhooks/mailgun', {
    method: 'POST',
    body: req.body,
    headers: { 'content-type': req.headers['content-type'] ?? '' },
  }))

  expect(res.status).toBe(200)
  expect(await tickets.count()).toBe(1)
})
```

## Faking time and nonces — Alibaba

`AlibabaDmTransport` signs every request with a timestamp + nonce. For end-to-end tests where you want a deterministic signature (e.g. you're asserting on the exact wire bytes the transport produced), inject both:

```ts
import { AlibabaDmTransport } from '@strav/mail'

const transport = new AlibabaDmTransport({
  accessKeyId: 'AK_TEST',
  accessKeySecret: 'AK_SECRET',
  accountName: 'noreply@acme.cn',
  fetch: stubFetch,
  now: () => new Date('2025-01-15T08:30:00Z'),
  nonce: () => 'nonce-1234',
})
```

The `now` and `nonce` hooks exist for this purpose. Production use leaves them at the default (`new Date()` + `crypto.randomUUID()`).

For most tests you don't need this — you're asserting on the recorded `Message` via `ArrayTransport`, not on the bytes a specific HTTP transport produces. Reach for the deterministic hooks only when you're testing the transport itself.

## Stubbing `fetch` for transport-level tests

When you're testing one of the HTTP transports directly (not the manager), provide a fake `fetch`:

```ts
import { MailgunTransport } from '@strav/mail'

test('Mailgun transport flags 5xx as retryable', async () => {
  const transport = new MailgunTransport({
    apiKey: 'k',
    domain: 'mg.x',
    fetch: async () => new Response('', { status: 503, statusText: 'Service Unavailable' }),
  })

  let caught: unknown
  try {
    await transport.send({ to: 'a@x', from: 'b@x', subject: 's', text: 't' })
  } catch (err) {
    caught = err
  }
  expect((caught as MailTransportError).context.retryable).toBe(true)
})
```

Every shipped HTTP transport accepts a `fetch` option for this. The default is the platform `fetch`; the option exists so you can stub responses, capture request bodies, and assert on auth headers without standing up a real provider.

## Snapshot tests on `Message`

`Message` is plain data, so snapshot tests work well as a regression net for content changes:

```ts
test('WelcomeEmail snapshot', async () => {
  await mail.send(WelcomeEmail, { userId: '01J...' })

  const [message] = (mail.via() as ArrayTransport).messages
  expect(message).toMatchSnapshot()
})
```

If the snapshot includes generated dates or ULIDs, normalise them before the assertion — or pass deterministic clocks / id generators into the Mailable's deps, the same way the Alibaba transport accepts `now` / `nonce`.

## Cleaning up between tests

Two patterns work:

1. **Per-test container.** `bootTestApp()` builds a fresh `MailManager` each time; the `ArrayTransport` starts empty by construction. Slightly slower, fully isolated.
2. **Shared container + `clear()`.** Reuse the container across the file; in `beforeEach`, call `(mail.via() as ArrayTransport).clear()`. Faster, but you have to remember.

Pick one and stick with it across the suite. Mixing the two is the source of "this test passes alone but fails in the suite" bugs.
