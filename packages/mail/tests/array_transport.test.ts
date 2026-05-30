import { beforeEach, describe, expect, test } from 'bun:test'
import { ArrayTransport, type Message } from '../src/index.ts'

describe('ArrayTransport', () => {
  let transport: ArrayTransport

  beforeEach(() => {
    transport = new ArrayTransport()
  })

  test('records sent messages in order', async () => {
    const m1: Message = { to: 'a@example.com', subject: '1', text: 'one' }
    const m2: Message = { to: 'b@example.com', subject: '2', text: 'two' }
    await transport.send(m1)
    await transport.send(m2)
    expect(transport.count).toBe(2)
    expect(transport.messages[0]?.subject).toBe('1')
    expect(transport.messages[1]?.subject).toBe('2')
  })

  test('clear() drops recorded messages', async () => {
    await transport.send({ to: 'a@x', subject: 'hi', text: 'h' })
    expect(transport.count).toBe(1)
    transport.clear()
    expect(transport.count).toBe(0)
    expect(transport.messages.length).toBe(0)
  })

  test('records a defensive copy — caller mutation does not corrupt history', async () => {
    const m: Message = { to: 'a@x', subject: 'before', text: 'h' }
    await transport.send(m)
    m.subject = 'mutated-after-send'
    expect(transport.messages[0]?.subject).toBe('before')
  })

  test('messages getter exposes a readonly view', () => {
    const view = transport.messages
    // Static type is `readonly Message[]`; runtime is still a regular
    // array but TS forbids mutation paths in app code.
    expect(Array.isArray(view)).toBe(true)
  })
})
