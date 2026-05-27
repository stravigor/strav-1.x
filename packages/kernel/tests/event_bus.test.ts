import { describe, expect, test } from 'bun:test'

import { EventBus } from '../src/events/event_bus.ts'

describe('EventBus.on / emit', () => {
  test('listener fires with payload', async () => {
    const bus = new EventBus()
    let received: unknown
    bus.on<{ id: number }>('user.created', (payload) => {
      received = payload
    })
    await bus.emit('user.created', { id: 42 })
    expect(received).toEqual({ id: 42 })
  })

  test('multiple listeners fire in registration order, sequentially', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on('e', async () => {
      order.push('first-start')
      await Promise.resolve()
      order.push('first-end')
    })
    bus.on('e', async () => {
      order.push('second-start')
      await Promise.resolve()
      order.push('second-end')
    })
    await bus.emit('e')
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  })

  test('emit awaits async listeners', async () => {
    const bus = new EventBus()
    let done = false
    bus.on('slow', async () => {
      await new Promise((r) => setTimeout(r, 10))
      done = true
    })
    await bus.emit('slow')
    expect(done).toBe(true)
  })

  test('emit with no listeners is a no-op', async () => {
    const bus = new EventBus()
    await bus.emit('nothing')
    expect(bus.listenerCount('nothing')).toBe(0)
  })

  test('listener name is the second argument', async () => {
    const bus = new EventBus()
    let receivedName: string | undefined
    bus.on('user.created', (_payload, name) => {
      receivedName = name
    })
    await bus.emit('user.created', null)
    expect(receivedName).toBe('user.created')
  })

  test('listener throw propagates from emit (M1.7 default)', async () => {
    const bus = new EventBus()
    bus.on('boom', () => {
      throw new Error('nope')
    })
    await expect(bus.emit('boom')).rejects.toThrow('nope')
  })
})

describe('EventBus.once', () => {
  test('fires at most once', async () => {
    const bus = new EventBus()
    let count = 0
    bus.once('x', () => {
      count += 1
    })
    await bus.emit('x')
    await bus.emit('x')
    expect(count).toBe(1)
  })

  test('once listener is removed before its own handler runs (no re-entrant double-fire)', async () => {
    const bus = new EventBus()
    let count = 0
    bus.once('x', async () => {
      count += 1
      // Re-emitting from inside the handler must not re-trigger us.
      await bus.emit('x')
    })
    await bus.emit('x')
    expect(count).toBe(1)
  })
})

describe('EventBus.unsubscribe', () => {
  test('on returns an unsubscribe that removes the listener', async () => {
    const bus = new EventBus()
    let count = 0
    const off = bus.on('e', () => {
      count += 1
    })
    await bus.emit('e')
    off()
    await bus.emit('e')
    expect(count).toBe(1)
  })

  test('once returns an unsubscribe — listener can be removed before it fires', async () => {
    const bus = new EventBus()
    let count = 0
    const off = bus.once('e', () => {
      count += 1
    })
    off()
    await bus.emit('e')
    expect(count).toBe(0)
  })

  test('removeAllListeners clears one event name', () => {
    const bus = new EventBus()
    bus.on('e', () => {})
    bus.on('f', () => {})
    bus.removeAllListeners('e')
    expect(bus.listenerCount('e')).toBe(0)
    expect(bus.listenerCount('f')).toBe(1)
  })

  test('removeAllListeners() with no name clears every event', () => {
    const bus = new EventBus()
    bus.on('e', () => {})
    bus.on('f', () => {})
    bus.removeAllListeners()
    expect(bus.listenerCount('e')).toBe(0)
    expect(bus.listenerCount('f')).toBe(0)
  })
})

describe('EventBus dispatch snapshot', () => {
  test('listener added during emit does not fire for that emission', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on('e', () => {
      order.push('first')
      bus.on('e', () => {
        order.push('added-during-dispatch')
      })
    })
    await bus.emit('e')
    expect(order).toEqual(['first'])
    // But it does fire on the next emission.
    await bus.emit('e')
    expect(order).toContain('added-during-dispatch')
  })
})
