import { describe, expect, test } from 'bun:test'
import {
  signWebhook,
  verifyWebhookSignature,
  WebhookNotificationDriver,
} from '../../../src/drivers/webhook/index.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'
import { NotificationDeliveryError } from '../../../src/notification_error.ts'

interface FetchCall {
  url: string
  init: RequestInit
}

interface FetchStub {
  calls: FetchCall[]
  fetch: typeof fetch
  reply(status: number, body?: string): void
  rejectWith(err: unknown): void
}

function makeFetchStub(): FetchStub {
  const calls: FetchCall[] = []
  let next: { status: number; body?: string } | { error: unknown } = { status: 200, body: '' }
  const stub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    if ('error' in next) throw next.error
    const { status, body } = next
    return new Response(body ?? '', {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
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

class InvoicePaid extends BaseNotification {
  constructor(private readonly payload: { invoiceId: string; amount: number }) {
    super()
  }
  override via(): readonly string[] {
    return ['webhook']
  }
  toWebhook(_n: Notifiable): Record<string, unknown> {
    return this.payload
  }
}

class NoHook extends BaseNotification {
  override via(): readonly string[] {
    return ['webhook']
  }
}

const alice: Notifiable = { id: 'u_1', notifiableType: 'User', email: 'a@b.co' }
const FIXED_NOW = new Date('2026-05-30T08:30:00Z')
const FIXED_TIMESTAMP = String(Math.floor(FIXED_NOW.getTime() / 1000))
const baseContext = { id: 'n_test_1', dispatchedAt: FIXED_NOW }

function makeDriver(
  stub: FetchStub,
  opts: Partial<{ headers: Record<string, string>; algorithm: 'sha256' | 'sha1' | 'sha512' }> = {},
) {
  return new WebhookNotificationDriver({
    name: 'webhook',
    endpoint: 'https://receiver.example/notifications',
    secret: 'shh',
    fetch: stub.fetch,
    now: () => FIXED_NOW,
    ...opts,
  })
}

describe('WebhookNotificationDriver', () => {
  test('POSTs a signed envelope when toWebhook returns data', async () => {
    const stub = makeFetchStub()
    const driver = makeDriver(stub)

    const result = await driver.send(
      alice,
      new InvoicePaid({ invoiceId: 'inv_1', amount: 4900 }),
      baseContext,
    )

    expect(result).toEqual({ channel: 'webhook', delivered: true, reference: 'n_test_1' })
    expect(stub.calls).toHaveLength(1)

    const call = stub.calls[0]!
    expect(call.url).toBe('https://receiver.example/notifications')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-strav-notification-id']).toBe('n_test_1')
    expect(headers['x-strav-notification-type']).toBe('InvoicePaid')
    expect(headers['x-strav-timestamp']).toBe(FIXED_TIMESTAMP)
    expect(headers['x-strav-signature']).toMatch(/^sha256=[a-f0-9]{64}$/)

    const body = call.init.body as string
    expect(JSON.parse(body)).toEqual({
      notification: {
        id: 'n_test_1',
        type: 'InvoicePaid',
        dispatchedAt: FIXED_NOW.toISOString(),
      },
      notifiable: { id: 'u_1', type: 'User' },
      data: { invoiceId: 'inv_1', amount: 4900 },
    })
  })

  test('signature is the canonical HMAC over `${timestamp}.${body}`', async () => {
    const stub = makeFetchStub()
    const driver = makeDriver(stub)

    await driver.send(alice, new InvoicePaid({ invoiceId: 'inv_1', amount: 4900 }), baseContext)

    const headers = stub.calls[0]!.init.headers as Record<string, string>
    const body = stub.calls[0]!.init.body as string
    const sig = headers['x-strav-signature']!.split('=')[1]!
    const expected = signWebhook('sha256', 'shh', headers['x-strav-timestamp']!, body)
    expect(sig).toBe(expected)
  })

  test('signature changes when the secret changes', async () => {
    const stubA = makeFetchStub()
    const stubB = makeFetchStub()
    await makeDriver(stubA).send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)
    await new WebhookNotificationDriver({
      name: 'webhook',
      endpoint: 'https://receiver.example/notifications',
      secret: 'OTHER',
      fetch: stubB.fetch,
      now: () => FIXED_NOW,
    }).send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)

    const sigA = (stubA.calls[0]!.init.headers as Record<string, string>)['x-strav-signature']
    const sigB = (stubB.calls[0]!.init.headers as Record<string, string>)['x-strav-signature']
    expect(sigA).not.toBe(sigB)
  })

  test('honors a different signing algorithm', async () => {
    const stub = makeFetchStub()
    const driver = makeDriver(stub, { algorithm: 'sha512' })

    await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)

    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-strav-signature']).toMatch(/^sha512=[a-f0-9]{128}$/)
  })

  test('merges configured headers but built-ins win', async () => {
    const stub = makeFetchStub()
    const driver = makeDriver(stub, {
      headers: {
        authorization: 'Bearer downstream',
        'x-tenant-id': 'acme',
        // attempt to override a built-in — should not win
        'x-strav-notification-id': 'attacker',
      },
    })

    await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)

    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer downstream')
    expect(headers['x-tenant-id']).toBe('acme')
    expect(headers['x-strav-notification-id']).toBe('n_test_1') // built-in wins
  })

  test('skips delivery when notification has no toWebhook hook', async () => {
    const stub = makeFetchStub()
    const driver = makeDriver(stub)

    const result = await driver.send(alice, new NoHook(), baseContext)

    expect(result).toEqual({ channel: 'webhook', delivered: false })
    expect(stub.calls).toHaveLength(0)
  })

  test('throws NotificationDeliveryError on 4xx (flagged non-retryable)', async () => {
    const stub = makeFetchStub()
    stub.reply(400, '{"error":"bad payload"}')
    const driver = makeDriver(stub)

    let caught: unknown
    try {
      await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    const ctx = (caught as NotificationDeliveryError).context
    expect(ctx['status']).toBe(400)
    expect(ctx['retryable']).toBe(false)
    expect(ctx['endpoint']).toBe('https://receiver.example/notifications')
    expect(ctx['responseBody']).toContain('bad payload')
  })

  test('flags 5xx as retryable', async () => {
    const stub = makeFetchStub()
    stub.reply(503, 'overloaded')
    const driver = makeDriver(stub)

    let caught: unknown
    try {
      await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)
    } catch (err) {
      caught = err
    }
    expect((caught as NotificationDeliveryError).context['retryable']).toBe(true)
  })

  test('flags 429 as retryable', async () => {
    const stub = makeFetchStub()
    stub.reply(429)
    const driver = makeDriver(stub)

    let caught: unknown
    try {
      await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)
    } catch (err) {
      caught = err
    }
    expect((caught as NotificationDeliveryError).context['retryable']).toBe(true)
  })

  test('wraps a network failure as retryable', async () => {
    const stub = makeFetchStub()
    stub.rejectWith(new TypeError('connect ECONNREFUSED'))
    const driver = makeDriver(stub)

    let caught: unknown
    try {
      await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as NotificationDeliveryError).context['retryable']).toBe(true)
  })

  test('truncates large response bodies in error context', async () => {
    const stub = makeFetchStub()
    stub.reply(500, 'X'.repeat(5000))
    const driver = makeDriver(stub)

    let caught: unknown
    try {
      await driver.send(alice, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)
    } catch (err) {
      caught = err
    }
    expect(((caught as NotificationDeliveryError).context['responseBody'] as string).length).toBe(
      1024,
    )
  })

  test('omits notifiable.type when notifiableType is absent', async () => {
    const stub = makeFetchStub()
    const driver = makeDriver(stub)
    const guest: Notifiable = { id: 'g_1' }

    await driver.send(guest, new InvoicePaid({ invoiceId: 'a', amount: 1 }), baseContext)

    const body = JSON.parse(stub.calls[0]!.init.body as string)
    expect(body.notifiable).toEqual({ id: 'g_1' })
  })
})

describe('verifyWebhookSignature', () => {
  test('round-trips a freshly-signed payload', () => {
    const ts = '1737000000'
    const body = '{"hello":"world"}'
    const sig = signWebhook('sha256', 'shh', ts, body)
    expect(verifyWebhookSignature('sha256', 'shh', ts, body, sig)).toBe(true)
  })

  test('rejects a tampered body', () => {
    const ts = '1737000000'
    const sig = signWebhook('sha256', 'shh', ts, '{"hello":"world"}')
    expect(verifyWebhookSignature('sha256', 'shh', ts, '{"hello":"WORLD"}', sig)).toBe(false)
  })

  test('rejects the wrong secret', () => {
    const ts = '1737000000'
    const body = '{"hello":"world"}'
    const sig = signWebhook('sha256', 'shh', ts, body)
    expect(verifyWebhookSignature('sha256', 'other', ts, body, sig)).toBe(false)
  })

  test('rejects a short signature without timing-safe compare throwing', () => {
    expect(verifyWebhookSignature('sha256', 'shh', '0', 'body', 'short')).toBe(false)
  })
})
