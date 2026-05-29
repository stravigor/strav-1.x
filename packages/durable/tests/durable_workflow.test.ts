/**
 * `DurableWorkflow` builder tests — covers the step registration
 * surface in isolation. Engine behavior (advance, compensate,
 * retries, idempotent replay) is covered by `durable_runner.test.ts`
 * against a real Postgres.
 */

import { describe, expect, test } from 'bun:test'
import {
  DurableError,
  DurableWorkflow,
  defineDurable,
  WorkflowNotRegisteredError,
  WorkflowRegistry,
} from '../src/index.ts'

describe('DurableWorkflow', () => {
  test('constructor rejects empty workflow name', () => {
    expect(() => new DurableWorkflow('')).toThrow(/non-empty string/)
  })

  test('.step() appends to the ordered step list', () => {
    const wf = new DurableWorkflow('demo')
      .step('a', async () => 'a-result')
      .step('b', async () => 'b-result')
    expect(wf.steps.map((s) => s.name)).toEqual(['a', 'b'])
    expect(wf.steps.map((s) => s.maxAttempts)).toEqual([3, 3])
  })

  test('.step() defaults: maxAttempts=3, exponential backoff capped at 60s', () => {
    const wf = new DurableWorkflow('demo').step('a', async () => 'r')
    const step = wf.steps[0]!
    expect(step.maxAttempts).toBe(3)
    expect(step.backoff(1)).toBe(2)
    expect(step.backoff(2)).toBe(4)
    expect(step.backoff(3)).toBe(8)
    // Cap at 60 — 2 ** 7 = 128 would overshoot.
    expect(step.backoff(7)).toBe(60)
  })

  test('.step() accepts compensate, maxAttempts, and backoff overrides', () => {
    let compensated = false
    const wf = new DurableWorkflow('demo').step('a', async () => 'r', {
      compensate: async () => {
        compensated = true
      },
      maxAttempts: 5,
      backoff: () => 1,
    })
    const step = wf.steps[0]!
    expect(step.maxAttempts).toBe(5)
    expect(step.backoff(99)).toBe(1)
    expect(step.compensate).toBeDefined()
    // Smoke-check the compensator was registered, not just truthy.
    return step.compensate?.({ input: {}, results: {}, runId: 'x', attempt: 1 }).then(() => {
      expect(compensated).toBe(true)
    })
  })

  test('.step() rejects duplicate names — journaled by name, would corrupt replay', () => {
    const wf = new DurableWorkflow('demo').step('a', async () => 'r')
    expect(() => wf.step('a', async () => 'r2')).toThrow(DurableError)
  })

  test('.step() rejects empty step name', () => {
    const wf = new DurableWorkflow('demo')
    expect(() => wf.step('', async () => 'r')).toThrow(/must be non-empty/)
  })
})

describe('defineDurable', () => {
  test('returns a DurableWorkflow with the given name and builder steps', () => {
    const wf = defineDurable('order', (b) =>
      b
        .step('validate', async () => true)
        .step('charge', async () => ({ id: 'ch_1' })),
    )
    expect(wf).toBeInstanceOf(DurableWorkflow)
    expect(wf.name).toBe('order')
    expect(wf.steps.map((s) => s.name)).toEqual(['validate', 'charge'])
  })
})

describe('WorkflowRegistry', () => {
  test('register / get / has / names round-trip', () => {
    const wf = new DurableWorkflow('demo')
    const registry = new WorkflowRegistry().register(wf)
    expect(registry.has('demo')).toBe(true)
    expect(registry.get('demo')).toBe(wf)
    expect(registry.names()).toEqual(['demo'])
  })

  test('register rejects duplicate workflow names', () => {
    const registry = new WorkflowRegistry().register(new DurableWorkflow('demo'))
    expect(() => registry.register(new DurableWorkflow('demo'))).toThrow(
      /already registered/,
    )
  })

  test('registerAll registers each provided workflow', () => {
    const registry = new WorkflowRegistry().registerAll([
      new DurableWorkflow('a'),
      new DurableWorkflow('b'),
    ])
    expect(registry.names().sort()).toEqual(['a', 'b'])
  })

  test('get throws WorkflowNotRegisteredError with the known list', () => {
    const registry = new WorkflowRegistry().register(new DurableWorkflow('a'))
    try {
      registry.get('missing')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowNotRegisteredError)
      expect((err as WorkflowNotRegisteredError).context).toEqual({
        name: 'missing',
        known: ['a'],
      })
    }
  })
})
