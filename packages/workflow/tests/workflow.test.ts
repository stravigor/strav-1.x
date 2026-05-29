/**
 * Workflow orchestration tests — covers the four step kinds
 * (sequential / parallel / route / loop), the saga compensation pass,
 * and the typed-builder progressive widening of `Results`.
 *
 * Async steps are real `await`s (no fake timers) so the tests also
 * incidentally exercise that handlers run in declaration order and
 * `Promise.all` semantics hold for the parallel block.
 */

import { describe, expect, test } from 'bun:test'
import {
  CompensationError,
  defineWorkflow,
  Workflow,
  WorkflowError,
} from '../src/index.ts'

// ─── Sequential ───────────────────────────────────────────────────────────

describe('Workflow — sequential steps', () => {
  test('runs steps in declaration order and accumulates results', async () => {
    const order: string[] = []
    const result = await defineWorkflow<{ x: number }>('seq')
      .step('a', async (ctx) => {
        order.push('a')
        return ctx.input.x + 1
      })
      .step('b', async (ctx) => {
        order.push('b')
        // typed: ctx.results.a is `number`
        return ctx.results.a * 2
      })
      .step('c', async (ctx) => {
        order.push('c')
        return `${ctx.results.b}`
      })
      .run({ x: 10 })

    expect(order).toEqual(['a', 'b', 'c'])
    expect(result.results).toEqual({ a: 11, b: 22, c: '22' })
    expect(typeof result.duration).toBe('number')
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  test('handler throw → WorkflowError carries step name + original cause', async () => {
    const wf = new Workflow<{ id: number }>('seq:fail')
      .step('first', async () => 'ok')
      .step('second', async () => {
        throw new Error('boom')
      })

    try {
      await wf.run({ id: 1 })
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
      expect((err as WorkflowError).code).toBe('workflow.step-failed')
      expect((err as WorkflowError).context).toEqual({ step: 'second' })
      expect((err as WorkflowError).cause).toBeInstanceOf(Error)
      expect(((err as WorkflowError).cause as Error).message).toBe('boom')
    }
  })

  test('non-Error throws are coerced via String()', async () => {
    try {
      await new Workflow<unknown>('seq:throw-string')
        .step('s', async () => {
          throw 'plain-string'
        })
        .run(undefined)
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
      expect((err as WorkflowError).message).toMatch(/plain-string/)
    }
  })
})

// ─── Parallel ─────────────────────────────────────────────────────────────

describe('Workflow — parallel fan-out', () => {
  test('runs handlers concurrently and stores each under its entry name', async () => {
    const start: number[] = []
    const wf = defineWorkflow<unknown>('par').parallel('send', [
      {
        name: 'email',
        handler: async () => {
          start.push(Date.now())
          await new Promise((r) => setTimeout(r, 10))
          return 'mail-sent'
        },
      },
      {
        name: 'sms',
        handler: async () => {
          start.push(Date.now())
          await new Promise((r) => setTimeout(r, 10))
          return 'sms-sent'
        },
      },
    ] as const)

    const result = await wf.run(undefined)
    expect(result.results).toEqual({ email: 'mail-sent', sms: 'sms-sent' })
    // Both handlers should have started within a few ms of each other —
    // sequential execution would have separated them by ≥10ms.
    expect(Math.abs(start[0]! - start[1]!)).toBeLessThan(5)
  })

  test('one entry throws → WorkflowError wraps the parallel block', async () => {
    const wf = defineWorkflow<unknown>('par:fail').parallel('fanout', [
      { name: 'good', handler: async () => 'ok' },
      {
        name: 'bad',
        handler: async () => {
          throw new Error('parallel boom')
        },
      },
    ] as const)

    try {
      await wf.run(undefined)
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
      expect((err as WorkflowError).context).toEqual({ step: 'fanout' })
    }
  })
})

// ─── Route ────────────────────────────────────────────────────────────────

describe('Workflow — route', () => {
  test('dispatches to the matching branch and stores its result', async () => {
    const wf = defineWorkflow<{ category: string }>('route')
      .step('classify', async (ctx) => ({ kind: ctx.input.category }))
      .route(
        'handle',
        (ctx) => ctx.results.classify.kind,
        {
          billing: async () => ({ via: 'billing' }) as const,
          shipping: async () => ({ via: 'shipping' }) as const,
        },
      )

    const billing = await wf.run({ category: 'billing' })
    expect(billing.results.handle).toEqual({ via: 'billing' })

    const shipping = await wf.run({ category: 'shipping' })
    expect(shipping.results.handle).toEqual({ via: 'shipping' })
  })

  test('unknown branch → silent no-op, no entry in results', async () => {
    const wf = defineWorkflow<{ category: string }>('route:unknown')
      .step('classify', async (ctx) => ({ kind: ctx.input.category }))
      .route('handle', (ctx) => ctx.results.classify.kind, {
        known: async () => 'matched',
      })

    const result = await wf.run({ category: 'absent' })
    expect(result.results.handle).toBeUndefined()
    // Other steps still landed.
    expect(result.results.classify).toEqual({ kind: 'absent' })
  })

  test('resolver throw bubbles as WorkflowError on the route step', async () => {
    const wf = defineWorkflow<unknown>('route:resolver-fail').route(
      'pick',
      async () => {
        throw new Error('resolver dead')
      },
      { default: async () => 'never' },
    )

    try {
      await wf.run(undefined)
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
      expect((err as WorkflowError).context).toEqual({ step: 'pick' })
    }
  })
})

// ─── Loop ─────────────────────────────────────────────────────────────────

describe('Workflow — loop', () => {
  test('iterates up to maxIterations, feeding each result back as the next input', async () => {
    const wf = defineWorkflow<{ seed: number }>('loop:double').loop(
      'grow',
      async (input: number) => input * 2,
      {
        maxIterations: 4,
        feedback: (r) => r,
        mapInput: (ctx) => ctx.input.seed,
      },
    )

    const result = await wf.run({ seed: 1 })
    expect(result.results.grow).toBe(16) // 1 → 2 → 4 → 8 → 16
  })

  test('until-predicate short-circuits before maxIterations', async () => {
    const seen: number[] = []
    const wf = defineWorkflow<{ seed: number }>('loop:until').loop(
      'climb',
      async (input: number) => {
        seen.push(input)
        return input + 1
      },
      {
        maxIterations: 100,
        feedback: (r) => r,
        until: (r) => r >= 5,
        mapInput: (ctx) => ctx.input.seed,
      },
    )

    const result = await wf.run({ seed: 0 })
    expect(result.results.climb).toBe(5)
    expect(seen).toEqual([0, 1, 2, 3, 4]) // until fires after 5th run
  })

  test('maxIterations === 0 → no run, no result entry', async () => {
    let calls = 0
    const wf = defineWorkflow<unknown>('loop:zero').loop(
      'nope',
      async () => {
        calls++
        return 'unused'
      },
      { maxIterations: 0 },
    )
    const result = await wf.run(undefined)
    expect(calls).toBe(0)
    expect(result.results.nope).toBeUndefined()
  })

  test('mapInput defaults to ctx.input when omitted', async () => {
    const wf = defineWorkflow<{ start: string }>('loop:default-input').loop(
      'echo',
      async (input) => input,
      { maxIterations: 1 },
    )
    const result = await wf.run({ start: 'hi' })
    // First iteration's input is ctx.input directly.
    expect(result.results.echo).toEqual({ start: 'hi' })
  })
})

// ─── Compensation ─────────────────────────────────────────────────────────

describe('Workflow — saga compensation', () => {
  test('failing step triggers reverse-order compensation on completed steps', async () => {
    const events: string[] = []
    const wf = new Workflow<{ id: number }>('saga')
      .step('reserve', async () => {
        events.push('reserve.run')
        return { reservation: 'r1' }
      }, {
        compensate: async () => {
          events.push('reserve.compensate')
        },
      })
      .step('charge', async () => {
        events.push('charge.run')
        return { id: 'ch1' }
      }, {
        compensate: async () => {
          events.push('charge.compensate')
        },
      })
      .step('ship', async () => {
        events.push('ship.run')
        throw new Error('ship blew up')
      })

    try {
      await wf.run({ id: 1 })
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
    }

    // Steps ran in declaration order; compensators ran in reverse.
    // ship has no compensator, so only charge + reserve compensate.
    expect(events).toEqual([
      'reserve.run',
      'charge.run',
      'ship.run',
      'charge.compensate',
      'reserve.compensate',
    ])
  })

  test('parallel entries compensate when a later step fails', async () => {
    const events: string[] = []
    const wf = defineWorkflow<unknown>('saga:parallel')
      .parallel('fanout', [
        {
          name: 'a',
          handler: async () => 'a-ok',
          compensate: async () => {
            events.push('a.compensate')
          },
        },
        {
          name: 'b',
          handler: async () => 'b-ok',
          compensate: async () => {
            events.push('b.compensate')
          },
        },
      ] as const)
      .step('after', async () => {
        throw new Error('after dead')
      })

    try {
      await wf.run(undefined)
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
      expect((err as WorkflowError).context).toEqual({ step: 'after' })
    }
    expect(events).toContain('a.compensate')
    expect(events).toContain('b.compensate')
  })

  test('compensator throw collects into CompensationError', async () => {
    const wf = new Workflow<unknown>('saga:cleanup-fail')
      .step('a', async () => 'ok', {
        compensate: async () => {
          throw new Error('a-cleanup dead')
        },
      })
      .step('b', async () => 'ok', {
        compensate: async () => {
          throw new Error('b-cleanup dead')
        },
      })
      .step('c', async () => {
        throw new Error('c failed')
      })

    try {
      await wf.run(undefined)
      throw new Error('expected CompensationError')
    } catch (err) {
      expect(err).toBeInstanceOf(CompensationError)
      const ce = err as CompensationError
      expect(ce.code).toBe('workflow.compensation-failed')
      const failures = ce.context.failures as Array<{ step: string; message: string }>
      // Both compensators failed; CompensationError carries the breakdown.
      expect(failures.map((f) => f.step).sort()).toEqual(['a', 'b'])
      // Original error message is preserved in context.
      expect((ce.context.originalError as { message: string }).message).toMatch(/c failed/)
    }
  })

  test('no compensation when there are no completed-step compensators', async () => {
    // Plain steps with no compensate option — failing one rethrows the
    // WorkflowError directly, no CompensationError.
    try {
      await new Workflow<unknown>('saga:no-compensators')
        .step('only', async () => {
          throw new Error('nope')
        })
        .run(undefined)
      throw new Error('expected WorkflowError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError)
      expect(err).not.toBeInstanceOf(CompensationError)
    }
  })
})

// ─── Plan introspection ───────────────────────────────────────────────────

describe('Workflow — plan()', () => {
  test('returns a snapshot of every step with its discriminator', () => {
    const wf = defineWorkflow<unknown>('plan')
      .step('a', async () => 'a')
      .parallel('b', [{ name: 'b1', handler: async () => 'b1' }] as const)
      .route('c', () => 'x', { x: async () => 'x' })
      .loop('d', async (x: unknown) => x, { maxIterations: 1 })

    const plan = wf.plan()
    expect(plan.map((s) => `${s.type}:${s.name}`)).toEqual([
      'step:a',
      'parallel:b',
      'route:c',
      'loop:d',
    ])
  })

  test('plan() returns a snapshot that doesn’t leak the internal array', () => {
    const wf = defineWorkflow<unknown>('plan:isolated').step('s', async () => 'ok')
    const snapshot = wf.plan()
    expect(snapshot.length).toBe(1)
    // Mutating the snapshot doesn't affect the workflow.
    ;(snapshot as unknown as unknown[]).push('garbage')
    expect(wf.plan().length).toBe(1)
  })
})

// ─── defineWorkflow convenience ───────────────────────────────────────────

describe('defineWorkflow', () => {
  test('produces a Workflow with the given name', () => {
    const wf = defineWorkflow<{ x: number }>('factory-name')
    expect(wf).toBeInstanceOf(Workflow)
    expect(wf.name).toBe('factory-name')
  })
})
