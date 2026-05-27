import { describe, expect, test } from 'bun:test'
import { Hasher } from '../src/hasher.ts'

describe('Hasher', () => {
  test('make + verify round-trip', async () => {
    const hasher = new Hasher()
    const hash = await hasher.make('correct-horse-battery-staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await hasher.verify('correct-horse-battery-staple', hash)).toBe(true)
  })

  test('verify rejects the wrong password', async () => {
    const hasher = new Hasher()
    const hash = await hasher.make('right')
    expect(await hasher.verify('wrong', hash)).toBe(false)
  })

  test('verify on empty input returns false (no throw)', async () => {
    const hasher = new Hasher()
    expect(await hasher.verify('', '')).toBe(false)
    expect(await hasher.verify('pwd', '')).toBe(false)
    expect(await hasher.verify('', '$argon2id$v=19$m=65536,t=3,p=4$irrelevant')).toBe(false)
  })

  test('verify on malformed hash returns false (no throw)', async () => {
    const hasher = new Hasher()
    expect(await hasher.verify('pwd', 'not-a-hash')).toBe(false)
  })

  test('needsRehash: false for hash at current settings', async () => {
    const hasher = new Hasher({ memoryCost: 65536, timeCost: 3 })
    const hash = await hasher.make('pwd')
    expect(hasher.needsRehash(hash)).toBe(false)
  })

  test('needsRehash: true when stored memory cost is below current', async () => {
    const weak = new Hasher({ memoryCost: 16384, timeCost: 2 })
    const hash = await weak.make('pwd')
    const strong = new Hasher({ memoryCost: 65536, timeCost: 3 })
    expect(strong.needsRehash(hash)).toBe(true)
  })

  test('needsRehash: true for non-argon2 hash', () => {
    const hasher = new Hasher()
    expect(hasher.needsRehash('$2b$10$bcryptish')).toBe(true)
    expect(hasher.needsRehash('plaintext')).toBe(true)
  })
})
