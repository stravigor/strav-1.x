/**
 * Flex builder tests — the JSON shape the builder emits is what
 * LINE will receive. Just check key invariants: `type`
 * discriminators, nesting, action shapes.
 */

import { describe, expect, test } from 'bun:test'
import { flex } from '../../src/line/line_flex.ts'

describe('flex builder', () => {
  test('bubble composes header / hero / body / footer', () => {
    const bubble = flex.bubble({
      header: flex.box('vertical', [flex.text('Header')]),
      hero: flex.image('https://x/hero.jpg'),
      body: flex.box('vertical', [
        flex.text('Hello', { weight: 'bold' }),
        flex.separator(),
        flex.text('Body line'),
      ]),
      footer: flex.box('horizontal', [
        flex.button({ action: flex.action.postback('Buy', 'sku=1') }),
      ]),
    })
    expect(bubble.type).toBe('bubble')
    expect(bubble.header?.type).toBe('box')
    expect(bubble.body?.contents).toHaveLength(3)
    expect((bubble.body?.contents[1] as { type: string }).type).toBe('separator')
    expect((bubble.footer?.contents[0] as { action: { type: string } }).action.type).toBe(
      'postback',
    )
  })

  test('carousel wraps an array of bubbles', () => {
    const c = flex.carousel([
      flex.bubble({ body: flex.box('vertical', [flex.text('A')]) }),
      flex.bubble({ body: flex.box('vertical', [flex.text('B')]) }),
    ])
    expect(c.type).toBe('carousel')
    expect(c.contents).toHaveLength(2)
    expect(c.contents.every((b) => b.type === 'bubble')).toBe(true)
  })

  test('action builders set type discriminators', () => {
    expect(flex.action.message('Yes', 'yes')).toMatchObject({
      type: 'message',
      label: 'Yes',
      text: 'yes',
    })
    expect(flex.action.postback('Buy', 'sku=1')).toMatchObject({ type: 'postback', data: 'sku=1' })
    expect(flex.action.uri('Site', 'https://x')).toMatchObject({ type: 'uri', uri: 'https://x' })
  })
})
