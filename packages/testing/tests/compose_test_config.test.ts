import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { composeTestConfig } from '../src/compose_test_config.ts'

describe('composeTestConfig', () => {
  const saved: Record<string, string | undefined> = {}
  const envKeys = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k]
    // Force a known shape for the URL-derivation path.
    process.env.DB_HOST = 'pg.test'
    process.env.DB_PORT = '5432'
    process.env.DB_USER = 'u'
    process.env.DB_PASSWORD = 'p@ss'
    process.env.DB_DATABASE = 'd'
  })

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test('supplies logger + database defaults when neither is in overrides', () => {
    const out = composeTestConfig({ rag: { default: 'x' } })
    expect(out.logger).toEqual({
      default: 'main',
      level: 'silent',
      channels: { main: { driver: 'stderr' } },
    })
    expect((out.database as { url: string }).url).toBe('postgres://u:p%40ss@pg.test:5432/d')
    expect(out.rag).toEqual({ default: 'x' })
  })

  test('user-supplied logger replaces the default verbatim', () => {
    const out = composeTestConfig({ logger: { default: 'main', level: 'debug', channels: {} } })
    expect((out.logger as { level: string }).level).toBe('debug')
  })

  test('user-supplied database replaces the default verbatim', () => {
    const out = composeTestConfig({ database: { url: 'postgres://custom' } })
    expect((out.database as { url: string }).url).toBe('postgres://custom')
  })

  test('throws when env is missing and no database override is supplied', () => {
    delete process.env.DB_HOST
    expect(() => composeTestConfig()).toThrow(/missing DB_HOST/)
  })

  test('does not throw when env is missing but database override is supplied', () => {
    delete process.env.DB_HOST
    expect(() => composeTestConfig({ database: { url: 'postgres://custom' } })).not.toThrow()
  })
})
