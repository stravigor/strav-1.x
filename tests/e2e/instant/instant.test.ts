/**
 * End-to-end smoke for `@strav/instant` + `@strav/instant/line`.
 *
 * Wire under test:
 *
 *   ConfigProvider({ instant }) → LoggerProvider →
 *   InstantProvider → LineInstantProvider
 *
 * Verifies:
 *   - `config.instant` flows through the kernel and the manager
 *     resolves the LINE driver factory on first `use()`.
 *   - Capability set includes LINE-specific flags (`send.flex`,
 *     `liff`, `richMenu`).
 *   - `manager.send(...)` reaches the stubbed `@line/bot-sdk` client
 *     with a correctly-mapped `PushMessageRequest`.
 *   - Webhook signature verification accepts a real HMAC-SHA256
 *     payload and `parseWebhook` normalizes a follow event.
 *
 * No network: the LINE `Client` is swapped on the resolved driver
 * before any send is issued.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { LineBotClient, messagingApi } from '@line/bot-sdk'
import { type InstantConfig, InstantManager, InstantProvider } from '@strav/instant'
import { LineDriver, LineInstantProvider } from '@strav/instant/line'
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'

const CHANNEL_SECRET = 'e2e-channel-secret'
const CHANNEL_ACCESS_TOKEN = 'e2e-channel-access-token'

interface ClientCalls {
  push: messagingApi.PushMessageRequest[]
  reply: messagingApi.ReplyMessageRequest[]
}

const calls: ClientCalls = { push: [], reply: [] }

function stubClient(): LineBotClient {
  return {
    pushMessage: async (req: messagingApi.PushMessageRequest) => {
      calls.push.push(req)
      return { sentMessages: [{ id: 'sent-1', quoteToken: 'q' }] }
    },
    replyMessage: async (req: messagingApi.ReplyMessageRequest) => {
      calls.reply.push(req)
      return { sentMessages: [{ id: 'sent-2', quoteToken: 'q' }] }
    },
  } as unknown as LineBotClient
}

let app: Application

beforeAll(async () => {
  const instantConfig: InstantConfig = {
    default: 'line',
    providers: {
      line: {
        driver: 'line',
        channelAccessToken: CHANNEL_ACCESS_TOKEN,
        channelSecret: CHANNEL_SECRET,
        liff: { channelId: '1234567890' },
      },
    },
  }

  app = new Application()
  app.useProviders([
    new ConfigProvider({
      logger: {
        default: 'main',
        level: 'silent',
        channels: { main: { driver: 'stderr' } },
      },
      instant: instantConfig as unknown as Record<string, unknown>,
    }),
    new LoggerProvider(),
    new InstantProvider(),
    new LineInstantProvider(),
  ])
  await app.start({ signalHandlers: false })

  // Swap the lazily-constructed driver's client with our stub so
  // sends never touch the network. Capability set + config
  // validation still come from the real LineDriver constructor.
  const manager = app.resolve(InstantManager)
  manager.useDriver(
    'line',
    new LineDriver({
      instanceName: 'line',
      config: {
        driver: 'line',
        channelAccessToken: CHANNEL_ACCESS_TOKEN,
        channelSecret: CHANNEL_SECRET,
        liff: { channelId: '1234567890' },
      },
      client: stubClient(),
    }),
  )
})

afterAll(async () => {
  await app?.shutdown()
})

describe('e2e — InstantManager + LINE driver', () => {
  test('manager resolves the configured LINE driver', () => {
    const manager = app.resolve(InstantManager)
    expect(manager.use().name).toBe('line')
    expect(manager.use().capabilities.has('send.flex')).toBe(true)
    expect(manager.use().capabilities.has('liff')).toBe(true)
    expect(manager.use().capabilities.has('richMenu')).toBe(true)
  })

  test('send delivers a LINE push payload via the stub client', async () => {
    const manager = app.resolve(InstantManager)
    const result = await manager.send('Uuser', {
      text: 'hello',
      quickReplies: [{ label: 'Hi', action: { type: 'message', text: 'hi' } }],
    })
    expect(result.accepted).toBe(true)
    expect(result.provider).toBe('line')
    expect(calls.push).toHaveLength(1)
    const sent = calls.push[0]!
    expect(sent.to).toBe('Uuser')
    expect(sent.messages[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect((sent.messages[0] as { quickReply?: unknown }).quickReply).toBeDefined()
  })

  test('webhook signature verify + parse round-trip', () => {
    const manager = app.resolve(InstantManager)
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'follow',
          mode: 'active',
          timestamp: 1_700_000_000_000,
          webhookEventId: 'WE1',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Ufollower' },
          replyToken: 'rt',
        },
      ],
    })
    const sig = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64')
    expect(manager.verify('line', body, sig)).toBe(true)
    expect(manager.verify('line', body, 'bogus')).toBe(false)
    const events = manager.parseWebhook('line', body)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'follow',
      provider: 'line',
      userId: 'Ufollower',
      source: 'user',
      replyToken: 'rt',
    })
  })
})
