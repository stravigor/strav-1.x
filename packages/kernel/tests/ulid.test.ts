import { describe, expect, test } from 'bun:test'

import { decodeUlidTime, isUlid, ulid } from '../src/helpers/ulid.ts'

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('ulid()', () => {
  test('produces a 26-char Crockford-Base32 string', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(id).toMatch(ULID_REGEX)
  })

  test('uses uppercase only', () => {
    const id = ulid()
    expect(id).toBe(id.toUpperCase())
  })

  test('omits the disallowed Crockford letters (I, L, O, U)', () => {
    for (let i = 0; i < 50; i++) {
      const id = ulid()
      expect(id).not.toMatch(/[ILOU]/)
    }
  })

  test('embeds the supplied timestamp in the first 10 characters', () => {
    const t = 1_700_000_000_000
    const id = ulid(t)
    expect(decodeUlidTime(id)).toBe(t)
  })

  test('two ULIDs in different milliseconds sort by time', () => {
    const a = ulid(1_000)
    const b = ulid(2_000)
    expect(a < b).toBe(true)
  })

  test('successive calls in the same ms are strictly increasing (monotonic)', () => {
    const t = 1_700_000_000_000
    const ids: string[] = []
    for (let i = 0; i < 10; i++) ids.push(ulid(t))
    for (let i = 1; i < ids.length; i++) {
      const curr = ids[i] as string
      const prev = ids[i - 1] as string
      expect(curr > prev).toBe(true)
    }
    // All share the same time prefix
    const firstPrefix = (ids[0] as string).slice(0, 10)
    for (const id of ids) expect(id.slice(0, 10)).toBe(firstPrefix)
  })

  test('switching to a later timestamp restarts the random portion', () => {
    ulid(5_000) // seed monotonic state
    const next = ulid(6_000)
    expect(decodeUlidTime(next)).toBe(6_000)
    expect(next).toMatch(ULID_REGEX)
  })

  test('rejects negative timestamps', () => {
    expect(() => ulid(-1)).toThrow(TypeError)
  })

  test('rejects non-finite timestamps', () => {
    expect(() => ulid(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    expect(() => ulid(Number.NaN)).toThrow(TypeError)
  })

  test('rejects timestamps past the 48-bit window', () => {
    expect(() => ulid(0xffff_ffff_ffff + 1)).toThrow(RangeError)
  })

  test('accepts the exact 48-bit maximum', () => {
    const id = ulid(0xffff_ffff_ffff)
    expect(decodeUlidTime(id)).toBe(0xffff_ffff_ffff)
  })

  test('accepts timestamp = 0', () => {
    const id = ulid(0)
    expect(id.startsWith('0000000000')).toBe(true)
    expect(decodeUlidTime(id)).toBe(0)
  })

  test('thousand ULIDs in the same ms remain unique and sorted', () => {
    const t = 1_700_000_000_000
    const ids = Array.from({ length: 1_000 }, () => ulid(t))
    const set = new Set(ids)
    expect(set.size).toBe(1_000)
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
  })
})

describe('isUlid', () => {
  test('accepts a freshly-generated ULID', () => {
    expect(isUlid(ulid())).toBe(true)
  })

  test('accepts canonical fixtures', () => {
    expect(isUlid('01HZX0000000000000000000A1')).toBe(true)
  })

  test('rejects non-strings', () => {
    expect(isUlid(null)).toBe(false)
    expect(isUlid(undefined)).toBe(false)
    expect(isUlid(12345)).toBe(false)
    expect(isUlid({})).toBe(false)
  })

  test('rejects wrong length', () => {
    expect(isUlid('')).toBe(false)
    expect(isUlid('TOOSHORT')).toBe(false)
    expect(isUlid('01HZX0000000000000000000A1EXTRA')).toBe(false)
  })

  test('rejects disallowed characters', () => {
    // U is not in the alphabet
    expect(isUlid('01HZX0000000000000000000AU')).toBe(false)
  })

  test('accepts lenient Crockford mappings (i, l → 1; o → 0)', () => {
    // Replace valid '1' chars with 'I' and 'L' — still parses.
    const lenient = '0lhZX0000000000000000000aI'
    expect(isUlid(lenient)).toBe(true)
  })
})

describe('decodeUlidTime', () => {
  test('round-trips a generated ULID', () => {
    const t = 1_700_000_123_456
    expect(decodeUlidTime(ulid(t))).toBe(t)
  })

  test('decodes lenient Crockford characters', () => {
    // Equivalent to '0000000001' (decimal 1) but written with I instead of 1
    expect(decodeUlidTime(`000000000I${'A'.repeat(16)}`)).toBe(1)
  })

  test('throws on wrong type', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing wrong-type input
    expect(() => decodeUlidTime(12345 as any)).toThrow(TypeError)
  })

  test('throws on wrong length', () => {
    expect(() => decodeUlidTime('TOOSHORT')).toThrow(TypeError)
  })

  test('throws on invalid characters', () => {
    expect(() => decodeUlidTime('@'.repeat(26))).toThrow(TypeError)
  })
})
