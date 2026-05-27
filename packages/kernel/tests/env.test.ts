import { afterEach, describe, expect, test } from 'bun:test'

import { env } from '../src/helpers/env.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Per-test env isolation
// ─────────────────────────────────────────────────────────────────────────────

const used: Set<string> = new Set()
function setEnv(name: string, value: string | undefined): void {
  used.add(name)
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  for (const name of used) delete process.env[name]
  used.clear()
})

// ─────────────────────────────────────────────────────────────────────────────
// env(name, default?)
// ─────────────────────────────────────────────────────────────────────────────

describe('env (string)', () => {
  test('reads a set env var', () => {
    setEnv('TEST_APP_NAME', 'hello')
    expect(env('TEST_APP_NAME')).toBe('hello')
  })

  test('returns undefined when unset and no default', () => {
    setEnv('TEST_MISSING', undefined)
    expect(env('TEST_MISSING')).toBeUndefined()
  })

  test('returns default when unset', () => {
    setEnv('TEST_MISSING', undefined)
    expect(env('TEST_MISSING', 'fallback')).toBe('fallback')
  })

  test('returns default when value is empty string', () => {
    setEnv('TEST_EMPTY', '')
    expect(env('TEST_EMPTY', 'fallback')).toBe('fallback')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// env.int
// ─────────────────────────────────────────────────────────────────────────────

describe('env.int', () => {
  test('parses a valid integer', () => {
    setEnv('TEST_PORT', '3000')
    expect(env.int('TEST_PORT')).toBe(3000)
  })

  test('returns default when unset', () => {
    setEnv('TEST_PORT', undefined)
    expect(env.int('TEST_PORT', 5432)).toBe(5432)
  })

  test('throws on non-numeric value', () => {
    setEnv('TEST_PORT', 'not-a-number')
    expect(() => env.int('TEST_PORT')).toThrow(/not a valid integer/)
  })

  test('throws on decimal value', () => {
    setEnv('TEST_PORT', '3.14')
    expect(() => env.int('TEST_PORT')).toThrow(/not a valid integer/)
  })

  test('negative integers work', () => {
    setEnv('TEST_OFFSET', '-7')
    expect(env.int('TEST_OFFSET')).toBe(-7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// env.bool
// ─────────────────────────────────────────────────────────────────────────────

describe('env.bool', () => {
  test.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    ['y', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['n', false],
    ['', false],
  ])('parses %s as %s', (input, expected) => {
    setEnv('TEST_FLAG', input)
    expect(env.bool('TEST_FLAG')).toBe(expected)
  })

  test('returns default when unset', () => {
    setEnv('TEST_FLAG', undefined)
    expect(env.bool('TEST_FLAG', true)).toBe(true)
    expect(env.bool('TEST_FLAG', false)).toBe(false)
  })

  test('throws on unrecognised value', () => {
    setEnv('TEST_FLAG', 'maybe')
    expect(() => env.bool('TEST_FLAG')).toThrow(/not a recognised boolean/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// env.list
// ─────────────────────────────────────────────────────────────────────────────

describe('env.list', () => {
  test('splits a comma-separated list', () => {
    setEnv('TEST_IPS', '10.0.0.1,10.0.0.2,10.0.0.3')
    expect(env.list('TEST_IPS')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3'])
  })

  test('trims whitespace around items', () => {
    setEnv('TEST_IPS', ' a , b ,c ')
    expect(env.list('TEST_IPS')).toEqual(['a', 'b', 'c'])
  })

  test('drops empty items', () => {
    setEnv('TEST_IPS', 'a,,b,')
    expect(env.list('TEST_IPS')).toEqual(['a', 'b'])
  })

  test('returns default when unset', () => {
    setEnv('TEST_IPS', undefined)
    expect(env.list('TEST_IPS', ['*'])).toEqual(['*'])
  })

  test('returns default when empty', () => {
    setEnv('TEST_IPS', '')
    expect(env.list('TEST_IPS', ['*'])).toEqual(['*'])
  })

  test('returns undefined when unset and no default', () => {
    setEnv('TEST_IPS', undefined)
    expect(env.list('TEST_IPS')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// env.required
// ─────────────────────────────────────────────────────────────────────────────

describe('env.required', () => {
  test('returns the value when set', () => {
    setEnv('TEST_KEY', 'abc')
    expect(env.required('TEST_KEY')).toBe('abc')
  })

  test('throws when unset', () => {
    setEnv('TEST_KEY', undefined)
    expect(() => env.required('TEST_KEY')).toThrow(/missing or empty/)
  })

  test('throws when empty', () => {
    setEnv('TEST_KEY', '')
    expect(() => env.required('TEST_KEY')).toThrow(/missing or empty/)
  })

  test('error message contains the variable name', () => {
    setEnv('TEST_KEY', undefined)
    expect(() => env.required('TEST_KEY')).toThrow(/TEST_KEY/)
  })
})
