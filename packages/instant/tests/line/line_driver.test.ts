/**
 * `LineDriver` tests with a mocked `@line/bot-sdk` client. Verifies
 * config validation, message mapping on send/reply/push/multicast,
 * webhook delegation, profile lookup, and LIFF / rich-menu lazy
 * accessors.
 */

import { describe, expect, test } from 'bun:test'
import type { LineBotClient, messagingApi } from '@line/bot-sdk'
import { InstantProviderError } from '../../src/errors.ts'
import { LineDriver } from '../../src/line/line_driver.ts'

interface ClientCalls {
  push: messagingApi.PushMessageRequest[]
  reply: messagingApi.ReplyMessageRequest[]
  multicast: messagingApi.MulticastRequest[]
  broadcast: messagingApi.BroadcastRequest[]
  profile: string[]
}

function makeMockClient(): { client: LineBotClient; calls: ClientCalls } {
  const calls: ClientCalls = { push: [], reply: [], multicast: [], broadcast: [], profile: [] }
  const client = {
    pushMessage: async (req: messagingApi.PushMessageRequest) => {
      calls.push.push(req)
      return { sentMessages: [{ id: 'sent-1', quoteToken: 'q' }] }
    },
    replyMessage: async (req: messagingApi.ReplyMessageRequest) => {
      calls.reply.push(req)
      return { sentMessages: [{ id: 'sent-2', quoteToken: 'q' }] }
    },
    multicast: async (req: messagingApi.MulticastRequest) => {
      calls.multicast.push(req)
      return {}
    },
    broadcast: async (req: messagingApi.BroadcastRequest) => {
      calls.broadcast.push(req)
      return {}
    },
    getProfile: async (userId: string) => {
      calls.profile.push(userId)
      return {
        userId,
        displayName: 'Alice',
        pictureUrl: 'https://x/a.jpg',
        statusMessage: 'hi',
        language: 'th',
      } satisfies messagingApi.UserProfileResponse
    },
  } as unknown as LineBotClient
  return { client, calls }
}

function makeDriver(overrides: { channelId?: string } = {}) {
  const { client, calls } = makeMockClient()
  const driver = new LineDriver({
    instanceName: 'line',
    config: {
      driver: 'line',
      channelAccessToken: 'tok',
      channelSecret: 'sec',
      ...(overrides.channelId !== undefined
        ? { liff: { channelId: overrides.channelId } }
        : {}),
    },
    client,
  })
  return { driver, calls }
}

describe('LineDriver — construction', () => {
  test('rejects missing channelAccessToken', () => {
    expect(
      () =>
        new LineDriver({
          instanceName: 'line',
          config: { driver: 'line', channelAccessToken: '', channelSecret: 'sec' },
        }),
    ).toThrow(InstantProviderError)
  })

  test('rejects missing channelSecret', () => {
    expect(
      () =>
        new LineDriver({
          instanceName: 'line',
          config: { driver: 'line', channelAccessToken: 'tok', channelSecret: '' },
        }),
    ).toThrow(InstantProviderError)
  })

  test('declares the expected capabilities', () => {
    const { driver } = makeDriver()
    for (const c of [
      'send.text',
      'send.flex',
      'reply',
      'push',
      'multicast',
      'broadcast',
      'richMenu',
      'beacon',
      'liff',
      'webhook.signature',
    ] as const) {
      expect(driver.capabilities.has(c)).toBe(true)
    }
  })
})

describe('LineDriver — send / push / reply / multicast / broadcast', () => {
  test('push maps text and returns sent-message id', async () => {
    const { driver, calls } = makeDriver()
    const result = await driver.push('Uuser', { text: 'hi' })
    expect(calls.push).toHaveLength(1)
    expect(calls.push[0]).toMatchObject({
      to: 'Uuser',
      messages: [{ type: 'text', text: 'hi' }],
    })
    expect(result).toMatchObject({ provider: 'line', accepted: true, messageId: 'sent-1' })
  })

  test('send delegates to push', async () => {
    const { driver, calls } = makeDriver()
    await driver.send('Uuser', { text: 'hi' })
    expect(calls.push).toHaveLength(1)
  })

  test('reply maps quickReplies onto the last message', async () => {
    const { driver, calls } = makeDriver()
    await driver.reply('tok', {
      text: 'pick',
      quickReplies: [{ label: 'Yes', action: { type: 'message', text: 'yes' } }],
    })
    expect(calls.reply[0]?.messages[0]).toMatchObject({
      type: 'text',
      quickReply: { items: [{ action: { type: 'message', label: 'Yes' } }] },
    })
  })

  test('multicast accepts a readonly recipient list', async () => {
    const { driver, calls } = makeDriver()
    await driver.multicast(['U1', 'U2'] as const, { text: 'hi' })
    expect(calls.multicast[0]).toMatchObject({ to: ['U1', 'U2'] })
  })

  test('broadcast omits recipients', async () => {
    const { driver, calls } = makeDriver()
    await driver.broadcast({ text: 'hi' })
    expect(calls.broadcast[0]).toMatchObject({ messages: [{ type: 'text', text: 'hi' }] })
  })

  test('profile normalises the response', async () => {
    const { driver, calls } = makeDriver()
    const p = await driver.profile('Uuser')
    expect(calls.profile).toEqual(['Uuser'])
    expect(p).toMatchObject({ userId: 'Uuser', displayName: 'Alice', language: 'th' })
  })
})

describe('LineDriver — webhook ops', () => {
  test('verifySignature returns false on bad signature', () => {
    const { driver } = makeDriver()
    expect(driver.webhook.verifySignature('{}', 'wrong-sig')).toBe(false)
  })

  test('parse returns normalized events', () => {
    const { driver } = makeDriver()
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'follow',
          mode: 'active',
          timestamp: 1,
          webhookEventId: 'WE',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Uuser' },
          replyToken: 'tok',
        },
      ],
    })
    const events = driver.webhook.parse(body)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('follow')
  })
})

describe('LineDriver — LIFF + rich menu lazy accessors', () => {
  test('liff getter throws when channelId is absent', () => {
    const { driver } = makeDriver()
    expect(() => driver.liff).toThrow(InstantProviderError)
  })

  test('liff getter returns an instance when channelId is set', () => {
    const { driver } = makeDriver({ channelId: '1234' })
    expect(driver.liff).toBeDefined()
  })

  test('richMenu getter is always available + memoizes', () => {
    const { driver } = makeDriver()
    expect(driver.richMenu).toBe(driver.richMenu)
  })
})
