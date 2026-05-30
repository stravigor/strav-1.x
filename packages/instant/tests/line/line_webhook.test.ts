/**
 * LINE webhook tests — HMAC-SHA256 signature verification + event
 * parsing into the framework's normalized `WebhookEvent` union.
 *
 * Builds a signed body manually so the test stays independent of
 * any LINE server.
 */

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { parseLineWebhook, verifyLineSignature } from '../../src/line/line_webhook.ts'

const CHANNEL_SECRET = 'shhh-channel-secret'

function sign(body: string): string {
  return createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64')
}

describe('verifyLineSignature', () => {
  test('accepts a valid HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ destination: 'Uxxxx', events: [] })
    const sig = sign(body)
    expect(verifyLineSignature(body, sig, CHANNEL_SECRET)).toBe(true)
  })

  test('rejects a tampered body', () => {
    const body = JSON.stringify({ destination: 'Uxxxx', events: [] })
    const sig = sign(body)
    expect(verifyLineSignature(`${body} `, sig, CHANNEL_SECRET)).toBe(false)
  })

  test('returns false when signature header is missing', () => {
    expect(verifyLineSignature('{}', null, CHANNEL_SECRET)).toBe(false)
    expect(verifyLineSignature('{}', undefined, CHANNEL_SECRET)).toBe(false)
  })
})

describe('parseLineWebhook', () => {
  test('normalizes a text message event', () => {
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: 1_700_000_000_000,
          webhookEventId: 'WE1',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Uuser' },
          replyToken: 'tok',
          message: {
            id: 'mid1',
            type: 'text',
            quoteToken: 'qt',
            text: 'hi there',
          },
        },
      ],
    })
    const [event] = parseLineWebhook(body)
    expect(event).toBeDefined()
    expect(event).toMatchObject({
      provider: 'line',
      type: 'message.text',
      text: 'hi there',
      messageId: 'mid1',
      userId: 'Uuser',
      source: 'user',
      replyToken: 'tok',
    })
    expect(event?.timestamp).toBeInstanceOf(Date)
  })

  test('normalizes a postback event', () => {
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'postback',
          mode: 'active',
          timestamp: 0,
          webhookEventId: 'WE2',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Uuser' },
          replyToken: 'tok',
          postback: { data: 'action=buy&sku=1' },
        },
      ],
    })
    const [event] = parseLineWebhook(body)
    expect(event).toMatchObject({ type: 'postback', data: 'action=buy&sku=1' })
  })

  test('normalizes a beacon event with kind=enter', () => {
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'beacon',
          mode: 'active',
          timestamp: 0,
          webhookEventId: 'WE3',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Uuser' },
          replyToken: 'tok',
          beacon: { hwid: 'd41d8cd98f', type: 'enter' },
        },
      ],
    })
    const [event] = parseLineWebhook(body)
    expect(event).toMatchObject({
      type: 'beacon',
      beacon: { hwid: 'd41d8cd98f', kind: 'enter' },
    })
  })

  test('normalizes follow + unfollow events', () => {
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'follow',
          mode: 'active',
          timestamp: 0,
          webhookEventId: 'WE4',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Uuser' },
          replyToken: 'tok',
        },
        {
          type: 'unfollow',
          mode: 'active',
          timestamp: 0,
          webhookEventId: 'WE5',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'Uuser' },
        },
      ],
    })
    const events = parseLineWebhook(body)
    expect(events.map((e) => e.type)).toEqual(['follow', 'unfollow'])
  })

  test('group source maps to source=group + sourceId', () => {
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'join',
          mode: 'active',
          timestamp: 0,
          webhookEventId: 'WE6',
          deliveryContext: { isRedelivery: false },
          source: { type: 'group', groupId: 'Cgroup', userId: 'Uuser' },
          replyToken: 'tok',
        },
      ],
    })
    const [event] = parseLineWebhook(body)
    expect(event).toMatchObject({ type: 'join', source: 'group', sourceId: 'Cgroup' })
  })

  test('unmodelled event types become {type:unknown} with raw preserved', () => {
    const raw = {
      type: 'videoPlayComplete',
      mode: 'active',
      timestamp: 0,
      webhookEventId: 'WE7',
      deliveryContext: { isRedelivery: false },
      source: { type: 'user', userId: 'Uuser' },
      replyToken: 'tok',
      videoPlayComplete: { trackingId: 'abc' },
    }
    const body = JSON.stringify({ destination: 'Ubot', events: [raw] })
    const [event] = parseLineWebhook(body)
    expect(event?.type).toBe('unknown')
    expect(event?.raw).toMatchObject({ videoPlayComplete: { trackingId: 'abc' } })
  })

  test('empty events array returns []', () => {
    expect(parseLineWebhook(JSON.stringify({ destination: 'Ubot', events: [] }))).toEqual([])
  })
})
