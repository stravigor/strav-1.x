import { describe, expect, test } from 'bun:test'
import {
  type DiscordMessage,
  DiscordNotificationDriver,
} from '../../../src/drivers/discord/index.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'
import { NotificationDeliveryError } from '../../../src/notification_error.ts'

interface FetchCall {
  url: string
  init: RequestInit
}

function makeFetchStub() {
  const calls: FetchCall[] = []
  let next: { status: number; body?: string; jsonBody?: unknown } | { error: unknown } = {
    status: 204,
    body: '',
  }
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    if ('error' in next) throw next.error
    const { status, body, jsonBody } = next
    const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : (body ?? '')
    return new Response(payload, {
      status,
      statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
      headers: jsonBody !== undefined ? { 'content-type': 'application/json' } : {},
    })
  }) as unknown as typeof fetch
  return {
    calls,
    fetch: fetchFn,
    reply(status: number, body?: string) {
      next = { status, body }
    },
    replyJson(status: number, jsonBody: unknown) {
      next = { status, jsonBody }
    },
    rejectWith(err: unknown) {
      next = { error: err }
    },
  }
}

class SimpleAlert extends BaseNotification {
  constructor(private readonly text: string) {
    super()
  }
  override via(): readonly string[] {
    return ['discord']
  }
  toDiscord(_n: Notifiable): string {
    return this.text
  }
}

class EnvelopeAlert extends BaseNotification {
  constructor(private readonly envelope: DiscordMessage) {
    super()
  }
  override via(): readonly string[] {
    return ['discord']
  }
  toDiscord(): DiscordMessage {
    return this.envelope
  }
}

class NoHook extends BaseNotification {
  override via(): readonly string[] {
    return ['discord']
  }
}

class DefaultsAwareAlert extends BaseNotification {
  public seenDefaults: { username?: string; avatarUrl?: string } | undefined
  override via(): readonly string[] {
    return ['discord']
  }
  toDiscord(_n: Notifiable, defaults: { username?: string; avatarUrl?: string }): string {
    this.seenDefaults = defaults
    return 'hi'
  }
}

const alice: Notifiable = { id: 'u_1', notifiableType: 'User' }
const FIXED_NOW = new Date('2026-05-30T08:30:00Z')
const ctx = { id: 'n_test_1', dispatchedAt: FIXED_NOW }
const WEBHOOK = 'https://discord.com/api/webhooks/123/abc'

describe('DiscordNotificationDriver', () => {
  test('string-shorthand hook → POST with content', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      fetch: stub.fetch,
    })

    const result = await driver.send(alice, new SimpleAlert('hello channel'), ctx)
    expect(result).toEqual({ channel: 'discord', delivered: true, reference: 'n_test_1' })
    expect(stub.calls).toHaveLength(1)

    const call = stub.calls[0]!
    expect(call.url).toBe(WEBHOOK)
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(call.init.body as string)).toEqual({ content: 'hello channel' })
  })

  test('channel defaults populate username + avatar_url; per-message wins', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      username: 'Strav',
      avatarUrl: 'https://strav.dev/avatar.png',
      fetch: stub.fetch,
    })

    // Channel defaults applied
    await driver.send(alice, new SimpleAlert('hi'), ctx)
    expect(JSON.parse(stub.calls[0]!.init.body as string)).toEqual({
      content: 'hi',
      username: 'Strav',
      avatar_url: 'https://strav.dev/avatar.png',
    })

    // Per-message wins
    stub.calls.length = 0
    await driver.send(
      alice,
      new EnvelopeAlert({ content: 'override', username: 'NotStrav', avatarUrl: 'https://x' }),
      ctx,
    )
    expect(JSON.parse(stub.calls[0]!.init.body as string)).toEqual({
      content: 'override',
      username: 'NotStrav',
      avatar_url: 'https://x',
    })
  })

  test('camel-case envelope keys map to Discord snake_case wire form', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      fetch: stub.fetch,
    })

    await driver.send(
      alice,
      new EnvelopeAlert({
        content: 'see embed',
        embeds: [{ title: 'Hi', description: 'body' }],
        allowedMentions: { parse: [] },
        threadName: 'release-1.0',
        flags: 4,
        extra: { applied_tags: ['announce'] },
      }),
      ctx,
    )

    const body = JSON.parse(stub.calls[0]!.init.body as string)
    expect(body).toEqual({
      content: 'see embed',
      embeds: [{ title: 'Hi', description: 'body' }],
      allowed_mentions: { parse: [] },
      thread_name: 'release-1.0',
      flags: 4,
      applied_tags: ['announce'],
    })
  })

  test('hook sees the channel defaults so it can branch on them', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      username: 'Strav',
      avatarUrl: 'https://strav.dev/a.png',
      fetch: stub.fetch,
    })

    const n = new DefaultsAwareAlert()
    await driver.send(alice, n, ctx)
    expect(n.seenDefaults).toEqual({ username: 'Strav', avatarUrl: 'https://strav.dev/a.png' })
  })

  test('webhook URL resolution — message > notifiable > config', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: 'https://discord.com/api/webhooks/default/x',
      fetch: stub.fetch,
    })

    // Notifiable URL beats config
    await driver.send(
      { id: 'u_2', discordWebhookUrl: 'https://discord.com/api/webhooks/notifiable/y' },
      new SimpleAlert('via-notifiable'),
      ctx,
    )
    expect(stub.calls[0]!.url).toBe('https://discord.com/api/webhooks/notifiable/y')

    // Message URL beats both
    stub.calls.length = 0
    await driver.send(
      { id: 'u_2', discordWebhookUrl: 'https://discord.com/api/webhooks/notifiable/y' },
      new EnvelopeAlert({
        content: 'via-message',
        webhookUrl: 'https://discord.com/api/webhooks/message/z',
      }),
      ctx,
    )
    expect(stub.calls[0]!.url).toBe('https://discord.com/api/webhooks/message/z')
  })

  test('returns delivered: false when no webhook URL is available', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({ name: 'discord', fetch: stub.fetch })

    const result = await driver.send(alice, new SimpleAlert('orphan'), ctx)
    expect(result).toEqual({ channel: 'discord', delivered: false })
    expect(stub.calls).toHaveLength(0)
  })

  test('returns delivered: false when notification has no toDiscord hook', async () => {
    const stub = makeFetchStub()
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      fetch: stub.fetch,
    })

    const result = await driver.send(alice, new NoHook(), ctx)
    expect(result).toEqual({ channel: 'discord', delivered: false })
    expect(stub.calls).toHaveLength(0)
  })

  test('wait: true appends ?wait=true and surfaces the created message id', async () => {
    const stub = makeFetchStub()
    stub.replyJson(200, { id: '1283746' })
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      wait: true,
      fetch: stub.fetch,
    })

    const result = await driver.send(alice, new SimpleAlert('hi'), ctx)
    expect(stub.calls[0]!.url).toBe(`${WEBHOOK}?wait=true`)
    expect(result).toEqual({ channel: 'discord', delivered: true, reference: '1283746' })
  })

  test('wait: true merges into existing query string', async () => {
    const stub = makeFetchStub()
    stub.replyJson(200, { id: 'm_1' })
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: `${WEBHOOK}?thread_id=99`,
      wait: true,
      fetch: stub.fetch,
    })

    await driver.send(alice, new SimpleAlert('hi'), ctx)
    expect(stub.calls[0]!.url).toBe(`${WEBHOOK}?thread_id=99&wait=true`)
  })

  test('4xx throws NotificationDeliveryError (non-retryable)', async () => {
    const stub = makeFetchStub()
    stub.reply(400, '{"message":"Bad webhook"}')
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      fetch: stub.fetch,
    })

    let caught: unknown
    try {
      await driver.send(alice, new SimpleAlert('hi'), ctx)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    const c = (caught as NotificationDeliveryError).context
    expect(c['status']).toBe(400)
    expect(c['retryable']).toBe(false)
    expect(c['responseBody']).toContain('Bad webhook')
  })

  test('429 + 5xx flag retryable: true', async () => {
    const driver = (stub: ReturnType<typeof makeFetchStub>) =>
      new DiscordNotificationDriver({ name: 'discord', webhookUrl: WEBHOOK, fetch: stub.fetch })

    const stub429 = makeFetchStub()
    stub429.reply(429, 'slow down')
    let r429: NotificationDeliveryError | undefined
    try {
      await driver(stub429).send(alice, new SimpleAlert('hi'), ctx)
    } catch (err) {
      r429 = err as NotificationDeliveryError
    }
    expect(r429?.context['retryable']).toBe(true)

    const stub503 = makeFetchStub()
    stub503.reply(503)
    let r503: NotificationDeliveryError | undefined
    try {
      await driver(stub503).send(alice, new SimpleAlert('hi'), ctx)
    } catch (err) {
      r503 = err as NotificationDeliveryError
    }
    expect(r503?.context['retryable']).toBe(true)
  })

  test('network failure is wrapped as retryable', async () => {
    const stub = makeFetchStub()
    stub.rejectWith(new TypeError('connect ECONNREFUSED'))
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      fetch: stub.fetch,
    })

    let caught: unknown
    try {
      await driver.send(alice, new SimpleAlert('hi'), ctx)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as NotificationDeliveryError).context['retryable']).toBe(true)
  })

  test('truncates large response bodies in error context', async () => {
    const stub = makeFetchStub()
    stub.reply(500, 'X'.repeat(5000))
    const driver = new DiscordNotificationDriver({
      name: 'discord',
      webhookUrl: WEBHOOK,
      fetch: stub.fetch,
    })

    let caught: unknown
    try {
      await driver.send(alice, new SimpleAlert('hi'), ctx)
    } catch (err) {
      caught = err
    }
    expect(((caught as NotificationDeliveryError).context['responseBody'] as string).length).toBe(
      1024,
    )
  })
})
