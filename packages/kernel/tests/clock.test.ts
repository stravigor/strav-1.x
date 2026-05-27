import { describe, expect, test } from 'bun:test'

import { type Clock, FrozenClock, SystemClock } from '../src/helpers/clock.ts'

describe('SystemClock', () => {
  test('now() returns a Date close to wall-clock', () => {
    const clock = new SystemClock()
    const before = Date.now()
    const now = clock.now()
    const after = Date.now()
    expect(now).toBeInstanceOf(Date)
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(after)
  })

  test('millis() agrees with Date.now() within 5ms', () => {
    const clock = new SystemClock()
    const a = clock.millis()
    const b = Date.now()
    expect(Math.abs(a - b)).toBeLessThan(5)
  })

  test('iso() returns a valid ISO-8601 string', () => {
    const iso = new SystemClock().iso()
    // Roundtrip — if it parses back, the format is valid.
    expect(Number.isNaN(Date.parse(iso))).toBe(false)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('satisfies the Clock interface', () => {
    const c: Clock = new SystemClock()
    expect(typeof c.now).toBe('function')
    expect(typeof c.millis).toBe('function')
    expect(typeof c.iso).toBe('function')
  })
})

describe('FrozenClock', () => {
  test('defaults to "now" when no argument is provided', () => {
    const before = Date.now()
    const clock = new FrozenClock()
    const after = Date.now()
    expect(clock.millis()).toBeGreaterThanOrEqual(before)
    expect(clock.millis()).toBeLessThanOrEqual(after)
  })

  test('accepts a millisecond number', () => {
    const clock = new FrozenClock(1_700_000_000_000)
    expect(clock.millis()).toBe(1_700_000_000_000)
    expect(clock.now()).toEqual(new Date(1_700_000_000_000))
  })

  test('accepts a Date instance', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    const clock = new FrozenClock(d)
    expect(clock.millis()).toBe(d.getTime())
  })

  test('all three accessors return the same instant', () => {
    const clock = new FrozenClock(1_700_000_000_000)
    expect(clock.now().getTime()).toBe(clock.millis())
    expect(clock.iso()).toBe(new Date(1_700_000_000_000).toISOString())
  })

  test('repeated calls return the same value (truly frozen)', () => {
    const clock = new FrozenClock(1_700_000_000_000)
    const a = clock.millis()
    const b = clock.millis()
    expect(a).toBe(b)
  })

  test('set(ms) replaces the frozen time', () => {
    const clock = new FrozenClock(1_000)
    clock.set(2_000)
    expect(clock.millis()).toBe(2_000)
  })

  test('set(Date) replaces the frozen time', () => {
    const clock = new FrozenClock(0)
    clock.set(new Date('2026-06-01T00:00:00.000Z'))
    expect(clock.iso()).toBe('2026-06-01T00:00:00.000Z')
  })

  test('advance(ms) moves time forward', () => {
    const clock = new FrozenClock(1_000)
    clock.advance(500)
    expect(clock.millis()).toBe(1_500)
    clock.advance(60_000)
    expect(clock.millis()).toBe(61_500)
  })

  test('advance accepts a negative value', () => {
    const clock = new FrozenClock(1_000)
    clock.advance(-300)
    expect(clock.millis()).toBe(700)
  })

  test('now() returns a fresh Date each call (caller mutation is safe)', () => {
    const clock = new FrozenClock(1_000)
    const d = clock.now()
    d.setTime(0)
    expect(clock.millis()).toBe(1_000) // unaffected
  })
})
