import { describe, expect, test } from 'bun:test'
import { normalizePath, normalizePrefix, StoragePathError } from '../src/index.ts'

describe('normalizePath', () => {
  test('passes through clean POSIX paths', () => {
    expect(normalizePath('reports/2026/q1.pdf')).toBe('reports/2026/q1.pdf')
    expect(normalizePath('a.txt')).toBe('a.txt')
  })

  test('trims leading + trailing whitespace', () => {
    expect(normalizePath('  reports/q1.pdf  ')).toBe('reports/q1.pdf')
  })

  test('rejects ../ traversal anywhere', () => {
    expect(() => normalizePath('../escape.txt')).toThrow(StoragePathError)
    expect(() => normalizePath('a/../b.txt')).toThrow(StoragePathError)
    expect(() => normalizePath('a/b/..')).toThrow(StoragePathError)
  })

  test('rejects absolute paths', () => {
    expect(() => normalizePath('/absolute.txt')).toThrow(StoragePathError)
    expect(() => normalizePath('/etc/passwd')).toThrow(StoragePathError)
  })

  test('rejects backslashes', () => {
    expect(() => normalizePath('win\\path.txt')).toThrow(StoragePathError)
  })

  test('rejects empty paths', () => {
    expect(() => normalizePath('')).toThrow(StoragePathError)
    expect(() => normalizePath('   ')).toThrow(StoragePathError)
  })

  test('rejects empty segments', () => {
    expect(() => normalizePath('a//b.txt')).toThrow(StoragePathError)
  })

  test('rejects "." segments', () => {
    expect(() => normalizePath('./a.txt')).toThrow(StoragePathError)
    expect(() => normalizePath('a/./b.txt')).toThrow(StoragePathError)
  })

  test('rejects control characters', () => {
    expect(() => normalizePath('a\nb.txt')).toThrow(StoragePathError)
    expect(() => normalizePath('a\x00b.txt')).toThrow(StoragePathError)
  })
})

describe('normalizePrefix', () => {
  test('allows trailing slash', () => {
    expect(normalizePrefix('reports/2026/')).toBe('reports/2026/')
  })

  test('allows no trailing slash', () => {
    expect(normalizePrefix('reports/2026')).toBe('reports/2026')
  })

  test('empty input returns empty string', () => {
    expect(normalizePrefix('')).toBe('')
    expect(normalizePrefix('  ')).toBe('')
  })

  test('rejects bare "/"', () => {
    expect(() => normalizePrefix('/')).toThrow(StoragePathError)
  })

  test('rejects ../ traversal', () => {
    expect(() => normalizePrefix('../a/')).toThrow(StoragePathError)
  })
})
