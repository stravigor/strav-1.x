import { describe, expect, test } from 'bun:test'
import { bindArgv, UsageError } from '../src/binder.ts'
import { parseSignature } from '../src/signature.ts'

function parsed(args: string[] = [], flags: Record<string, string | boolean> = {}) {
  return { command: 'cmd', args, flags }
}

describe('bindArgv — positionals', () => {
  test('binds required + optional by name', () => {
    const sig = parseSignature('cmd {slug} {target?}')
    const out = bindArgv(sig, parsed(['acme', '/tmp']))
    expect(out.args).toEqual({ slug: 'acme', target: '/tmp' })
  })

  test('optional positional resolves to undefined when missing', () => {
    const sig = parseSignature('cmd {slug} {target?}')
    const out = bindArgv(sig, parsed(['acme']))
    expect(out.args).toEqual({ slug: 'acme', target: undefined })
  })

  test('throws UsageError on missing required positional', () => {
    const sig = parseSignature('cmd {slug}')
    expect(() => bindArgv(sig, parsed([]))).toThrow(UsageError)
    expect(() => bindArgv(sig, parsed([]))).toThrow(/missing argument: <slug>/)
  })

  test('throws UsageError on unexpected extra positional', () => {
    const sig = parseSignature('cmd {slug}')
    expect(() => bindArgv(sig, parsed(['a', 'b']))).toThrow(/unexpected argument: "b"/)
  })
})

describe('bindArgv — flags', () => {
  test('declared flag defaults applied when absent', () => {
    const sig = parseSignature('cmd {--out=storage/backups} {--bare}')
    const out = bindArgv(sig, parsed())
    expect(out.flags).toEqual({ out: 'storage/backups', bare: false })
  })

  test('string flag picks up explicit value', () => {
    const sig = parseSignature('cmd {--out=storage/backups}')
    const out = bindArgv(sig, parsed([], { out: '/tmp' }))
    expect(out.flags.out).toBe('/tmp')
  })

  test('boolean flag flips on bare --flag', () => {
    const sig = parseSignature('cmd {--bare}')
    const out = bindArgv(sig, parsed([], { bare: true }))
    expect(out.flags.bare).toBe(true)
  })

  test('string flag with no value throws UsageError', () => {
    const sig = parseSignature('cmd {--out=storage/backups}')
    expect(() => bindArgv(sig, parsed([], { out: true }))).toThrow(/flag --out requires a value/)
  })

  test('undeclared flags pass through unchanged', () => {
    const sig = parseSignature('cmd')
    const out = bindArgv(sig, parsed([], { extra: 'value', verbose: true }))
    expect(out.flags).toEqual({ extra: 'value', verbose: true })
  })
})
