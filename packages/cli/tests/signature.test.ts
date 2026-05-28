import { describe, expect, test } from 'bun:test'
import { ConfigError } from '@strav/kernel'
import { parseSignature } from '../src/signature.ts'

describe('parseSignature', () => {
  test('bare command name', () => {
    const sig = parseSignature('migrate')
    expect(sig.name).toBe('migrate')
    expect(sig.args).toEqual([])
    expect(sig.flags).toEqual([])
  })

  test('namespaced command name (kebab + colon)', () => {
    expect(parseSignature('queue:work').name).toBe('queue:work')
    expect(parseSignature('make:controller').name).toBe('make:controller')
  })

  test('required + optional positionals', () => {
    const sig = parseSignature('tenant:backup {slug} {target?}')
    expect(sig.args).toEqual([
      { name: 'slug', optional: false },
      { name: 'target', optional: true },
    ])
  })

  test('boolean flag vs string flag with default', () => {
    const sig = parseSignature('foo {--bare} {--out=storage/backups}')
    expect(sig.flags).toEqual([
      { kind: 'boolean', name: 'bare', default: false },
      { kind: 'string', name: 'out', default: 'storage/backups' },
    ])
  })

  test('flag with a default containing "="', () => {
    // Only the first '=' splits name from value; everything after is value.
    const sig = parseSignature('foo {--query=a=b}')
    expect(sig.flags[0]).toEqual({ kind: 'string', name: 'query', default: 'a=b' })
  })

  test('rejects required after optional', () => {
    expect(() => parseSignature('foo {a?} {b}')).toThrow(ConfigError)
  })

  test('rejects duplicate positional name', () => {
    expect(() => parseSignature('foo {a} {a}')).toThrow(/declared twice/)
  })

  test('rejects duplicate flag name', () => {
    expect(() => parseSignature('foo {--x} {--x=hi}')).toThrow(/declared twice/)
  })

  test('rejects unbraced token after the command name', () => {
    expect(() => parseSignature('foo bar')).toThrow(/must be wrapped/)
  })

  test('rejects unterminated brace', () => {
    expect(() => parseSignature('foo {slug')).toThrow(/unterminated/)
  })

  test('rejects empty signature', () => {
    expect(() => parseSignature('')).toThrow(/empty signature/)
  })

  test('rejects signature starting with a brace', () => {
    expect(() => parseSignature('{slug}')).toThrow(/first token must be the command name/)
  })

  test('rejects invalid identifier characters', () => {
    expect(() => parseSignature('foo {slug.name}')).toThrow(/valid identifier/)
  })
})
