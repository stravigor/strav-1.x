/**
 * Builder tests for the V2 node-type extensions:
 * sleep / waitForSignal / parallel / route / loop / childWorkflow.
 *
 * Runner-level integration is covered in `durable_runner.test.ts`
 * (Postgres-gated). These tests verify the builder shape, defaults,
 * and the duplicate-name guard the journaling model depends on.
 */

import { describe, expect, test } from 'bun:test'
import { DurableError, DurableWorkflow } from '../src/index.ts'
import type {
  DurableChildWorkflow,
  DurableLoop,
  DurableParallel,
  DurableRoute,
  DurableSleep,
  DurableWaitForSignal,
} from '../src/types.ts'

describe('DurableWorkflow.sleep', () => {
  test('appends a sleep node with the given duration', () => {
    const wf = new DurableWorkflow('demo').sleep('wait', 30)
    const node = wf.steps[0]
    expect(node?.type).toBe('sleep')
    expect((node as DurableSleep).delay).toBe(30)
  })

  test('accepts a context-aware delay function', () => {
    const wf = new DurableWorkflow('demo').sleep('wait', (ctx) =>
      (ctx.input.delaySec as number) ?? 60,
    )
    expect(typeof (wf.steps[0] as DurableSleep).delay).toBe('function')
  })
})

describe('DurableWorkflow.waitForSignal', () => {
  test('records the signal name', () => {
    const wf = new DurableWorkflow('demo').waitForSignal('approval', 'approve.order')
    const node = wf.steps[0] as DurableWaitForSignal
    expect(node.type).toBe('waitForSignal')
    expect(node.signalName).toBe('approve.order')
  })

  test('accepts a context-aware signal name', () => {
    const wf = new DurableWorkflow('demo').waitForSignal('webhook', (ctx) =>
      `webhook.${ctx.input.requestId as string}`,
    )
    expect(typeof (wf.steps[0] as DurableWaitForSignal).signalName).toBe('function')
  })
})

describe('DurableWorkflow.parallel', () => {
  test('records each branch handler', () => {
    const wf = new DurableWorkflow('demo').parallel('fanout', {
      a: async () => 1,
      b: async () => 2,
    })
    const node = wf.steps[0] as DurableParallel
    expect(node.type).toBe('parallel')
    expect(Object.keys(node.branches)).toEqual(['a', 'b'])
    expect(node.maxAttempts).toBe(3)
  })

  test('rejects an empty branches map', () => {
    const wf = new DurableWorkflow('demo')
    expect(() => wf.parallel('fanout', {})).toThrow(/at least one branch/)
  })

  test('options override maxAttempts + backoff', () => {
    const wf = new DurableWorkflow('demo').parallel(
      'fanout',
      { a: async () => 1 },
      { maxAttempts: 5, backoff: () => 7 },
    )
    const node = wf.steps[0] as DurableParallel
    expect(node.maxAttempts).toBe(5)
    expect(node.backoff(2)).toBe(7)
  })
})

describe('DurableWorkflow.route', () => {
  test('records the select fn and branch map', () => {
    const wf = new DurableWorkflow('demo').route(
      'choice',
      (ctx) => (ctx.input.kind as string) ?? 'a',
      { a: async () => 'A', b: async () => 'B' },
    )
    const node = wf.steps[0] as DurableRoute
    expect(node.type).toBe('route')
    expect(Object.keys(node.branches)).toEqual(['a', 'b'])
  })

  test('rejects an empty branches map', () => {
    const wf = new DurableWorkflow('demo')
    expect(() => wf.route('choice', () => 'a', {})).toThrow(/at least one branch/)
  })
})

describe('DurableWorkflow.loop', () => {
  test('records condition + body + default maxIterations', () => {
    const wf = new DurableWorkflow('demo').loop(
      'each',
      (_ctx, i) => i < 3,
      async (ctx) => ctx.iteration * 2,
    )
    const node = wf.steps[0] as DurableLoop
    expect(node.type).toBe('loop')
    expect(node.maxIterations).toBe(1000)
  })

  test('options override maxIterations', () => {
    const wf = new DurableWorkflow('demo').loop(
      'each',
      () => true,
      async () => null,
      { maxIterations: 10 },
    )
    expect((wf.steps[0] as DurableLoop).maxIterations).toBe(10)
  })
})

describe('DurableWorkflow.childWorkflow', () => {
  test('records the start fn + default pollIntervalSec', () => {
    const wf = new DurableWorkflow('demo').childWorkflow('sub', async () => ({
      name: 'child',
      input: { x: 1 },
    }))
    const node = wf.steps[0] as DurableChildWorkflow
    expect(node.type).toBe('childWorkflow')
    expect(node.pollIntervalSec).toBe(2)
  })

  test('options override pollIntervalSec', () => {
    const wf = new DurableWorkflow('demo').childWorkflow(
      'sub',
      async () => ({ name: 'child' }),
      { pollIntervalSec: 10 },
    )
    expect((wf.steps[0] as DurableChildWorkflow).pollIntervalSec).toBe(10)
  })
})

describe('DurableWorkflow — composition + duplicate guard', () => {
  test('node names share the duplicate guard across all builder methods', () => {
    const wf = new DurableWorkflow('demo').step('a', async () => 1)
    expect(() => wf.sleep('a', 5)).toThrow(DurableError)
    expect(() => wf.waitForSignal('a', 'x')).toThrow(DurableError)
    expect(() => wf.parallel('a', { x: async () => 1 })).toThrow(DurableError)
    expect(() => wf.route('a', () => 'x', { x: async () => 1 })).toThrow(DurableError)
    expect(() => wf.loop('a', () => false, async () => null)).toThrow(DurableError)
    expect(() => wf.childWorkflow('a', async () => ({ name: 'c' }))).toThrow(DurableError)
  })

  test('builder methods chain', () => {
    const wf = new DurableWorkflow('demo')
      .step('s', async () => 1)
      .sleep('z', 5)
      .waitForSignal('w', 'x')
      .parallel('p', { a: async () => 1 })
      .route('r', () => 'a', { a: async () => 1 })
      .loop('l', () => false, async () => null)
      .childWorkflow('c', async () => ({ name: 'sub' }))
    expect(wf.steps.map((s) => s.type)).toEqual([
      'step',
      'sleep',
      'waitForSignal',
      'parallel',
      'route',
      'loop',
      'childWorkflow',
    ])
  })
})
