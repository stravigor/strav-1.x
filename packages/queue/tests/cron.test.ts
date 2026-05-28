import { describe, expect, test } from 'bun:test'
import {
  CronExpression,
  cron,
  daily,
  dailyAt,
  everyMinute,
  everyMinutes,
  hourly,
} from '../src/index.ts'

// All dates below use UTC explicitly — CronExpression matches against UTC.

describe('CronExpression — parsing', () => {
  test('rejects wrong field count', () => {
    expect(() => new CronExpression('* * * *')).toThrow(/5 space-separated fields/)
    expect(() => new CronExpression('* * * * * *')).toThrow(/5 space-separated fields/)
  })

  test('rejects bad step values', () => {
    expect(() => new CronExpression('*/0 * * * *')).toThrow(/bad step/)
    expect(() => new CronExpression('*/-1 * * * *')).toThrow(/bad step/)
    expect(() => new CronExpression('*/abc * * * *')).toThrow(/bad step/)
  })

  test('rejects out-of-range values per field', () => {
    expect(() => new CronExpression('60 * * * *')).toThrow(/minute.*out of range/)
    expect(() => new CronExpression('* 24 * * *')).toThrow(/hour.*out of range/)
    expect(() => new CronExpression('* * 0 * *')).toThrow(/day-of-month.*out of range/)
    expect(() => new CronExpression('* * * 13 *')).toThrow(/month.*out of range/)
    expect(() => new CronExpression('* * * * 7')).toThrow(/day-of-week.*out of range/)
  })

  test('rejects backwards ranges', () => {
    expect(() => new CronExpression('5-3 * * * *')).toThrow(/start > end/)
  })

  test('accepts literal field values', () => {
    // Every field literal — 30 minutes, hour 14, day-of-month 28, month 5, day-of-week 4 (Thursday).
    // 2026-05-28 is a Thursday (dow=4).
    const e = new CronExpression('30 14 28 5 4')
    expect(e.matches(new Date('2026-05-28T14:30:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T14:31:00Z'))).toBe(false)
    expect(e.matches(new Date('2026-05-28T15:30:00Z'))).toBe(false)
  })

  test('accepts wildcards', () => {
    const e = new CronExpression('* * * * *')
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-12-31T23:59:00Z'))).toBe(true)
  })

  test('accepts ranges', () => {
    const e = new CronExpression('0-15 * * * *')
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:15:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:16:00Z'))).toBe(false)
  })

  test('accepts comma-lists', () => {
    const e = new CronExpression('0,15,30,45 * * * *')
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:31:00Z'))).toBe(false)
  })

  test('accepts step values', () => {
    const e = new CronExpression('*/15 * * * *')
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:15:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:45:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:01:00Z'))).toBe(false)
  })

  test('accepts range-with-step', () => {
    const e = new CronExpression('0-30/10 * * * *')
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:10:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:20:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:40:00Z'))).toBe(false)
  })

  test('mixed lists + ranges + steps', () => {
    const e = new CronExpression('0,30,*/15 * * * *')
    // 0, 30 from literals; 0, 15, 30, 45 from */15 — union is {0,15,30,45}
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:15:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:45:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:10:00Z'))).toBe(false)
  })

  test('every field must match for the overall match', () => {
    const e = new CronExpression('0 14 * * *')
    expect(e.matches(new Date('2026-05-28T14:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T15:00:00Z'))).toBe(false) // wrong hour
    expect(e.matches(new Date('2026-05-28T14:01:00Z'))).toBe(false) // wrong minute
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Helper builders
// ─────────────────────────────────────────────────────────────────────────────

describe('Cron helper builders', () => {
  test('everyMinute', () => {
    const e = everyMinute()
    expect(e.expression).toBe('* * * * *')
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(true)
  })

  test('everyMinutes(15)', () => {
    const e = everyMinutes(15)
    expect(e.expression).toBe('*/15 * * * *')
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:15:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:14:00Z'))).toBe(false)
  })

  test('everyMinutes rejects non-positive integers', () => {
    expect(() => everyMinutes(0)).toThrow(/positive integer/)
    expect(() => everyMinutes(-5)).toThrow(/positive integer/)
    expect(() => everyMinutes(1.5)).toThrow(/positive integer/)
  })

  test('hourly', () => {
    const e = hourly()
    expect(e.expression).toBe('0 * * * *')
    expect(e.matches(new Date('2026-05-28T10:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T10:30:00Z'))).toBe(false)
  })

  test('daily', () => {
    const e = daily()
    expect(e.expression).toBe('0 0 * * *')
    expect(e.matches(new Date('2026-05-28T00:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T00:01:00Z'))).toBe(false)
  })

  test('dailyAt parses HH:MM', () => {
    const e = dailyAt('02:00')
    expect(e.expression).toBe('0 2 * * *')
    expect(e.matches(new Date('2026-05-28T02:00:00Z'))).toBe(true)
  })

  test('dailyAt with single-digit hour', () => {
    expect(dailyAt('9:30').expression).toBe('30 9 * * *')
  })

  test('dailyAt rejects bad format', () => {
    expect(() => dailyAt('14')).toThrow(/HH:MM/)
    expect(() => dailyAt('14:5')).toThrow(/HH:MM/) // need MM, not M
    expect(() => dailyAt('25:00')).toThrow(/out of range/)
    expect(() => dailyAt('10:60')).toThrow(/out of range/)
  })

  test('cron pass-through', () => {
    const e = cron('0 */6 * * *')
    expect(e.expression).toBe('0 */6 * * *')
    expect(e.matches(new Date('2026-05-28T00:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T06:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T12:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T18:00:00Z'))).toBe(true)
    expect(e.matches(new Date('2026-05-28T07:00:00Z'))).toBe(false)
  })
})
