import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { Container, inject } from '../src/core/index.ts'
import { EventBus } from '../src/events/event_bus.ts'

// Silence the default console.error during tests; replaced per-suite when we
// want to assert on the report channel.
const origConsoleError = console.error
beforeEach(() => {
  console.error = mock(() => {}) as unknown as typeof console.error
})
afterEach(() => {
  console.error = origConsoleError
})

// ─────────────────────────────────────────────────────────────────────────────
// emit (sequential, M1.7 surface preserved)
// ─────────────────────────────────────────────────────────────────────────────

describe('emit (sequential)', () => {
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
})

// ─────────────────────────────────────────────────────────────────────────────
// Cancelable contract
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelable contract', () => {
  test('non-cancelable event: listener throw is caught + reported, others still run', async () => {
    const errorHandler = mock((_err: unknown, _name: string) => {})
    const bus = new EventBus({ onListenerError: errorHandler })

    const order: string[] = []
    bus.on('user.created', () => {
      order.push('first')
      throw new Error('first fail')
    })
    bus.on('user.created', () => {
      order.push('second')
    })

    await bus.emit('user.created')

    expect(order).toEqual(['first', 'second'])
    expect(errorHandler).toHaveBeenCalledTimes(1)
    const errCall = (errorHandler.mock.calls[0] ?? []) as [Error, string]
    expect(errCall[0].message).toBe('first fail')
    expect(errCall[1]).toBe('user.created')
  })

  test('cancelable event: first throw rejects emit and stops the chain', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on('user.creating', () => {
      order.push('first')
      throw new Error('blocked')
    })
    bus.on('user.creating', () => {
      order.push('second')
    })

    await expect(bus.emit('user.creating')).rejects.toThrow('blocked')
    expect(order).toEqual(['first'])
  })

  test.each([
    ['user.creating', true],
    ['order.updating', true],
    ['user.deleting', true],
    ['user.restoring', true],
    ['user.created', false],
    ['user.updated', false],
    ['app:booted', false],
    ['app:starting', false],
    ['lead.qualified', false],
  ])('isCancelable default predicate: %s → %s', async (name, shouldCancel) => {
    const bus = new EventBus()
    bus.on(name, () => {
      throw new Error('x')
    })
    if (shouldCancel) {
      await expect(bus.emit(name)).rejects.toThrow('x')
    } else {
      await expect(bus.emit(name)).resolves.toBeUndefined()
    }
  })

  test('custom isCancelable predicate', async () => {
    const bus = new EventBus({ isCancelable: (n) => n.startsWith('strict:') })
    bus.on('strict:gate', () => {
      throw new Error('blocked')
    })
    bus.on('lax:gate', () => {
      throw new Error('logged')
    })
    await expect(bus.emit('strict:gate')).rejects.toThrow('blocked')
    await expect(bus.emit('lax:gate')).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// emitParallel
// ─────────────────────────────────────────────────────────────────────────────

describe('emitParallel', () => {
  test('runs listeners concurrently', async () => {
    const bus = new EventBus()
    const t0 = Date.now()
    bus.on('e', async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    bus.on('e', async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    bus.on('e', async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    await bus.emitParallel('e')
    const elapsed = Date.now() - t0
    // Sequential would be ~90ms; parallel ~30ms. Give generous headroom.
    expect(elapsed).toBeLessThan(80)
  })

  test('partial failure: errors reported, emit resolves', async () => {
    const errors: unknown[] = []
    const bus = new EventBus({ onListenerError: (e) => errors.push(e) })
    bus.on('e', async () => {})
    bus.on('e', async () => {
      throw new Error('boom')
    })
    bus.on('e', async () => {})
    await expect(bus.emitParallel('e')).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
  })

  test('all listeners fail: AggregateError thrown', async () => {
    const bus = new EventBus()
    bus.on('e', () => {
      throw new Error('a')
    })
    bus.on('e', () => {
      throw new Error('b')
    })
    try {
      await bus.emitParallel('e')
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const agg = error as AggregateError
      expect(agg.errors).toHaveLength(2)
      expect((agg.errors[0] as Error).message).toBe('a')
      expect((agg.errors[1] as Error).message).toBe('b')
    }
  })

  test('cancelable events are forbidden — throws synchronously', () => {
    const bus = new EventBus()
    bus.on('user.creating', () => {})
    expect(bus.emitParallel('user.creating')).rejects.toThrow(/cannot emitParallel/i)
  })

  test('no listeners: resolves without error', async () => {
    const bus = new EventBus()
    await expect(bus.emitParallel('nothing')).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// once
// ─────────────────────────────────────────────────────────────────────────────

describe('once', () => {
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

  test('listener removed before its handler runs (no re-entrant double-fire)', async () => {
    const bus = new EventBus()
    let count = 0
    bus.once('x', async () => {
      count += 1
      await bus.emit('x') // re-entrant — must not refire this listener
    })
    await bus.emit('x')
    expect(count).toBe(1)
  })

  test('once unsubscribe removes it before fire', async () => {
    const bus = new EventBus()
    let count = 0
    const off = bus.once('e', () => {
      count += 1
    })
    off()
    await bus.emit('e')
    expect(count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

describe('unsubscribe', () => {
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

  test('removeAllListeners clears one event pattern', () => {
    const bus = new EventBus()
    bus.on('e', () => {})
    bus.on('f', () => {})
    bus.removeAllListeners('e')
    expect(bus.listenerCount('e')).toBe(0)
    expect(bus.listenerCount('f')).toBe(1)
  })

  test('removeAllListeners() clears everything', () => {
    const bus = new EventBus()
    bus.on('e', () => {})
    bus.on('f', () => {})
    bus.removeAllListeners()
    expect(bus.listenerCount('e')).toBe(0)
    expect(bus.listenerCount('f')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Wildcards
// ─────────────────────────────────────────────────────────────────────────────

describe('wildcards', () => {
  test('* matches every event', async () => {
    const bus = new EventBus()
    const captured: string[] = []
    bus.on('*', (_payload, name) => {
      captured.push(name ?? 'unknown')
    })
    await bus.emit('user.created')
    await bus.emit('order.paid')
    await bus.emit('app:booted')
    expect(captured).toEqual(['user.created', 'order.paid', 'app:booted'])
  })

  test('prefix.* matches one-segment after prefix', async () => {
    const bus = new EventBus()
    const captured: string[] = []
    bus.on('user.*', (_payload, name) => {
      captured.push(name ?? '')
    })
    await bus.emit('user.created')
    await bus.emit('user.updated')
    await bus.emit('user.profile.updated') // two segments after `user.` — should NOT match
    await bus.emit('order.paid')
    expect(captured).toEqual(['user.created', 'user.updated'])
  })

  test('wildcards interleave with specific listeners in registration order', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on('user.*', () => {
      order.push('wildcard-1')
    })
    bus.on('user.created', () => {
      order.push('specific')
    })
    bus.on('user.*', () => {
      order.push('wildcard-2')
    })
    await bus.emit('user.created')
    expect(order).toEqual(['wildcard-1', 'specific', 'wildcard-2'])
  })

  test('* does not match nothing (empty event name)', async () => {
    const bus = new EventBus()
    let fired = false
    bus.on('user.*', () => {
      fired = true
    })
    await bus.emit('user.')
    expect(fired).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Batch registration
// ─────────────────────────────────────────────────────────────────────────────

describe('batch on / subscribe', () => {
  test('on(name, [listeners]) — multiple listeners, one event', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on('e', [
      () => {
        order.push('a')
      },
      () => {
        order.push('b')
      },
      () => {
        order.push('c')
      },
    ])
    await bus.emit('e')
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('on([names], listener) — one listener, multiple events', async () => {
    const bus = new EventBus()
    const captured: string[] = []
    bus.on(['user.created', 'user.updated'], (_p, name) => {
      captured.push(name ?? '')
    })
    await bus.emit('user.created')
    await bus.emit('user.updated')
    await bus.emit('user.deleted') // not in the array
    expect(captured).toEqual(['user.created', 'user.updated'])
  })

  test('on([names], [listeners]) — cross-product', async () => {
    const bus = new EventBus()
    let count = 0
    bus.on(
      ['e1', 'e2'],
      [
        () => {
          count += 1
        },
        () => {
          count += 10
        },
      ],
    )
    await bus.emit('e1')
    await bus.emit('e2')
    // 2 events × 2 listeners = 4 fires; 1+10+1+10 = 22
    expect(count).toBe(22)
  })

  test('subscribe(map) — keyed by event name', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.subscribe({
      'user.created': [
        () => {
          order.push('a')
        },
        () => {
          order.push('b')
        },
      ],
      'user.deleted': () => {
        order.push('c')
      },
      'user.*': () => {
        order.push('w')
      },
    })
    await bus.emit('user.created')
    await bus.emit('user.deleted')
    expect(order).toEqual(['a', 'b', 'w', 'c', 'w'])
  })

  test('batch unsubscribe removes EVERY registration from that call', async () => {
    const bus = new EventBus()
    let count = 0
    const off = bus.subscribe({
      e1: () => {
        count += 1
      },
      e2: [
        () => {
          count += 10
        },
        () => {
          count += 100
        },
      ],
    })
    off()
    await bus.emit('e1')
    await bus.emit('e2')
    expect(count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Listener shapes — function / class / instance
// ─────────────────────────────────────────────────────────────────────────────

describe('listener shapes', () => {
  test('plain function listener', async () => {
    const bus = new EventBus()
    let fired = false
    bus.on('e', () => {
      fired = true
    })
    await bus.emit('e')
    expect(fired).toBe(true)
  })

  test('instance listener with .handle', async () => {
    const bus = new EventBus()
    const captured: unknown[] = []
    const instance = {
      handle(payload: unknown) {
        captured.push(payload)
      },
    }
    bus.on('e', instance)
    await bus.emit('e', 42)
    expect(captured).toEqual([42])
  })

  test('class listener auto-made per emit via the container', async () => {
    @inject()
    class Logger {
      readonly id = Math.random()
    }
    @inject()
    class HandleUserCreated {
      constructor(public log: Logger) {}
      handle(payload: { id: string }) {
        seenIds.push(`${this.log.id}-${payload.id}`)
      }
    }
    const seenIds: string[] = []

    const container = new Container().singleton(Logger)
    const bus = new EventBus({ resolver: <T>(C: new (...a: unknown[]) => T) => container.make(C) })
    bus.on<{ id: string }>('user.created', HandleUserCreated)

    await bus.emit('user.created', { id: 'a' })
    await bus.emit('user.created', { id: 'b' })

    // Two emits → two HandleUserCreated instances; same Logger (singleton).
    expect(seenIds).toHaveLength(2)
    const [first, second] = seenIds
    const firstLoggerId = first?.split('-')[0]
    const secondLoggerId = second?.split('-')[0]
    expect(firstLoggerId).toBe(secondLoggerId)
    expect(first?.endsWith('a')).toBe(true)
    expect(second?.endsWith('b')).toBe(true)
  })

  test('class listener without resolver: error caught and reported (non-cancelable)', async () => {
    @inject()
    class HandleSomething {
      handle() {}
    }
    const reported: unknown[] = []
    const bus = new EventBus({
      onListenerError: (err) => {
        reported.push(err)
      },
    })
    bus.on('e', HandleSomething)
    await bus.emit('e')
    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toMatch(/no container resolver configured/)
  })

  test('class listener without resolver on a CANCELABLE event: error propagates', async () => {
    @inject()
    class HandleCreating {
      handle() {}
    }
    const bus = new EventBus()
    bus.on('user.creating', HandleCreating)
    await expect(bus.emit('user.creating')).rejects.toThrow(/no container resolver configured/)
  })

  test('class listener missing .handle is rejected at registration', () => {
    @inject()
    class Bad {
      run() {}
    }
    const bus = new EventBus({ resolver: <T>(_C: new (...a: unknown[]) => T) => ({}) as T })
    // biome-ignore lint/suspicious/noExplicitAny: deliberately passing a bad listener shape
    expect(() => bus.on('e', Bad as any)).toThrow(/no \.handle\(\) method/)
  })

  test('non-callable, non-handle object is rejected', () => {
    const bus = new EventBus()
    expect(() => bus.on('e', { wrong: () => {} } as never)).toThrow(/must be a function/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatch snapshot', () => {
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
    await bus.emit('e')
    expect(order).toContain('added-during-dispatch')
  })
})
