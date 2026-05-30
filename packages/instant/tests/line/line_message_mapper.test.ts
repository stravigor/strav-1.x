/**
 * Mapper tests — `OutgoingMessage` → LINE message JSON.
 */

import { describe, expect, test } from 'bun:test'
import { InstantProviderError } from '../../src/errors.ts'
import { toLineMessages } from '../../src/line/line_message_mapper.ts'

describe('toLineMessages', () => {
  test('text → single text message', () => {
    const out = toLineMessages({ text: 'hello' })
    expect(out).toEqual([{ type: 'text', text: 'hello' }])
  })

  test('image attachment uses originalContentUrl + previewImageUrl', () => {
    const out = toLineMessages({
      attachments: [{ type: 'image', url: 'https://x/a.jpg', previewUrl: 'https://x/p.jpg' }],
    })
    expect(out).toEqual([
      { type: 'image', originalContentUrl: 'https://x/a.jpg', previewImageUrl: 'https://x/p.jpg' },
    ])
  })

  test('image without previewUrl falls back to url for preview', () => {
    const out = toLineMessages({ attachments: [{ type: 'image', url: 'https://x/a.jpg' }] })
    expect(out[0]).toMatchObject({ previewImageUrl: 'https://x/a.jpg' })
  })

  test('location attachment includes lat/lng + title/address', () => {
    const out = toLineMessages({
      attachments: [
        {
          type: 'location',
          latitude: 1.234,
          longitude: 5.678,
          title: 'Office',
          address: 'Bangkok',
        },
      ],
    })
    expect(out).toEqual([
      { type: 'location', title: 'Office', address: 'Bangkok', latitude: 1.234, longitude: 5.678 },
    ])
  })

  test('file attachment degrades to text link (no first-class LINE shape)', () => {
    const out = toLineMessages({
      attachments: [{ type: 'file', url: 'https://x/doc.pdf', fileName: 'doc.pdf' }],
    })
    expect(out[0]).toMatchObject({ type: 'text', text: 'doc.pdf\nhttps://x/doc.pdf' })
  })

  test('text + image fan out to two messages', () => {
    const out = toLineMessages({
      text: 'caption',
      attachments: [{ type: 'image', url: 'https://x/a.jpg' }],
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'text' })
    expect(out[1]).toMatchObject({ type: 'image' })
  })

  test('quickReplies attach to the LAST message', () => {
    const out = toLineMessages({
      text: 'pick one',
      quickReplies: [
        { label: 'Yes', action: { type: 'message', text: 'yes' } },
        { label: 'Buy', action: { type: 'postback', data: 'buy', displayText: 'Bought!' } },
        { label: 'Site', action: { type: 'uri', uri: 'https://x' } },
      ],
    })
    const last = out[out.length - 1] as { quickReply?: { items?: unknown[] } }
    expect(last.quickReply?.items).toHaveLength(3)
    expect(last.quickReply?.items?.[0]).toMatchObject({
      type: 'action',
      action: { type: 'message', label: 'Yes', text: 'yes' },
    })
    expect(last.quickReply?.items?.[1]).toMatchObject({
      action: { type: 'postback', label: 'Buy', data: 'buy', displayText: 'Bought!' },
    })
    expect(last.quickReply?.items?.[2]).toMatchObject({
      action: { type: 'uri', label: 'Site', uri: 'https://x' },
    })
  })

  test('raw passthrough wins over LCD fields', () => {
    const flexLike = { type: 'flex', altText: 'fallback', contents: { type: 'bubble' } }
    const out = toLineMessages({ text: 'ignored', raw: flexLike })
    expect(out).toEqual([flexLike] as unknown as typeof out)
  })

  test('throws when message is empty', () => {
    expect(() => toLineMessages({})).toThrow(InstantProviderError)
  })
})
