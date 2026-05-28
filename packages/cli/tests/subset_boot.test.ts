import { describe, expect, test } from 'bun:test'
import { ConfigError, ServiceProvider } from '@strav/kernel'
import { selectProviders } from '../src/subset_boot.ts'

class FakeProvider extends ServiceProvider {
  constructor(
    public override readonly name: string,
    public override readonly dependencies: readonly string[] = [],
  ) {
    super()
  }
}

describe('selectProviders', () => {
  test('undefined → full default list', () => {
    const a = new FakeProvider('a')
    const b = new FakeProvider('b')
    expect(selectProviders([a, b], undefined, 'cmd').map((p) => p.name)).toEqual(['a', 'b'])
  })

  test('[] → empty list', () => {
    expect(selectProviders([new FakeProvider('a')], [], 'cmd')).toEqual([])
  })

  test('named subset includes transitive dependencies', () => {
    const config = new FakeProvider('config')
    const logger = new FakeProvider('logger', ['config'])
    const database = new FakeProvider('database', ['config', 'logger'])
    const http = new FakeProvider('http', ['config', 'logger'])
    const result = selectProviders([config, logger, database, http], ['database'], 'migrate')
    expect(new Set(result.map((p) => p.name))).toEqual(new Set(['config', 'logger', 'database']))
    expect(result.map((p) => p.name)).not.toContain('http')
  })

  test('unknown provider name throws ConfigError', () => {
    expect(() => selectProviders([new FakeProvider('a')], ['nope'], 'cmd')).toThrow(ConfigError)
    expect(() => selectProviders([new FakeProvider('a')], ['nope'], 'cmd')).toThrow(
      /declared provider 'nope'/,
    )
  })

  test('circular dependency throws ConfigError', () => {
    const a = new FakeProvider('a', ['b'])
    const b = new FakeProvider('b', ['a'])
    expect(() => selectProviders([a, b], ['a'], 'cmd')).toThrow(/circular provider dependency/)
  })
})
