import { describe, expect, test } from 'bun:test'
import { ConfigError } from '@strav/kernel'
import { isJobClass, Job, type JobContext, JobRegistry } from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

class FixtureJob extends Job<{ value: number }> {
  static override readonly jobName = 'fixture.test'
  async handle(_ctx: JobContext<{ value: number }>): Promise<void> {
    // no-op
  }
}

class OtherJob extends Job<{ msg: string }> {
  static override readonly jobName = 'fixture.other'
  async handle(_ctx: JobContext<{ msg: string }>): Promise<void> {
    // no-op
  }
}

class NoNameJob extends Job<unknown> {
  // Deliberately doesn't override jobName — should be rejected.
  async handle(): Promise<void> {}
}

class ConflictingJob extends Job<unknown> {
  static override readonly jobName = 'fixture.test'
  async handle(): Promise<void> {}
}

// ─────────────────────────────────────────────────────────────────────────────
// register / registerAll / get / getOrFail / has / all
// ─────────────────────────────────────────────────────────────────────────────

describe('JobRegistry — register + get', () => {
  test('register + get round-trip by jobName', () => {
    const reg = new JobRegistry()
    reg.register(FixtureJob)
    expect(reg.get('fixture.test')).toBe(FixtureJob)
    expect(reg.has('fixture.test')).toBe(true)
  })

  test('register returns `this` for chaining', () => {
    const reg = new JobRegistry()
    expect(reg.register(FixtureJob)).toBe(reg)
  })

  test('registering the same instance twice is a no-op (dedupe by identity)', () => {
    const reg = new JobRegistry()
    reg.register(FixtureJob).register(FixtureJob)
    expect(reg.all()).toHaveLength(1)
  })

  test('register throws when jobName is empty / missing', () => {
    const reg = new JobRegistry()
    expect(() => reg.register(NoNameJob)).toThrow(ConfigError)
  })

  test('register throws when a DIFFERENT class claims the same jobName', () => {
    const reg = new JobRegistry()
    reg.register(FixtureJob)
    expect(() => reg.register(ConflictingJob)).toThrow(ConfigError)
  })

  test('registerAll registers many', () => {
    const reg = new JobRegistry()
    reg.registerAll([FixtureJob, OtherJob])
    expect(
      reg
        .all()
        .map((c) => c.jobName)
        .sort(),
    ).toEqual(['fixture.other', 'fixture.test'])
  })

  test('get returns undefined for unknown names', () => {
    const reg = new JobRegistry()
    expect(reg.get('not.registered')).toBeUndefined()
  })

  test('getOrFail throws for unknown names', () => {
    const reg = new JobRegistry()
    expect(() => reg.getOrFail('not.registered')).toThrow(/no Job is registered/)
  })

  test('has returns boolean', () => {
    const reg = new JobRegistry()
    reg.register(FixtureJob)
    expect(reg.has('fixture.test')).toBe(true)
    expect(reg.has('nope')).toBe(false)
  })

  test('all returns insertion order', () => {
    const reg = new JobRegistry()
    reg.register(OtherJob).register(FixtureJob)
    expect(reg.all().map((c) => c.jobName)).toEqual(['fixture.other', 'fixture.test'])
  })

  test('clear wipes the registry (test helper)', () => {
    const reg = new JobRegistry()
    reg.register(FixtureJob)
    reg.clear()
    expect(reg.all()).toHaveLength(0)
    expect(reg.has('fixture.test')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isJobClass — type-guard used by discover()
// ─────────────────────────────────────────────────────────────────────────────

describe('isJobClass', () => {
  test('returns true for a Job subclass with a non-empty jobName', () => {
    expect(isJobClass(FixtureJob)).toBe(true)
  })

  test('rejects the Job base class itself (abstract — not registerable)', () => {
    expect(isJobClass(Job)).toBe(false)
  })

  test('rejects subclasses with an empty jobName', () => {
    expect(isJobClass(NoNameJob)).toBe(false)
  })

  test('rejects non-functions', () => {
    expect(isJobClass(null)).toBe(false)
    expect(isJobClass(undefined)).toBe(false)
    expect(isJobClass({})).toBe(false)
    expect(isJobClass('FixtureJob')).toBe(false)
    expect(isJobClass(42)).toBe(false)
  })

  test('rejects functions whose prototype does NOT extend Job', () => {
    class Bystander {
      static jobName = 'looks.like.a.job.but.isnt'
      handle(): void {}
    }
    expect(isJobClass(Bystander)).toBe(false)
  })

  test('rejects subclasses with a non-string jobName', () => {
    class WeirdName extends Job<unknown> {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong-typed for the test
      static override jobName: any = 42
      async handle(): Promise<void> {}
    }
    expect(isJobClass(WeirdName)).toBe(false)
  })
})
