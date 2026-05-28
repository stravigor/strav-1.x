import { describe, expect, test } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from '@strav/kernel'
import { Archetype, defineSchema, isSchema, SchemaRegistry } from '../src/index.ts'

const FIXTURES_CWD = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('SchemaRegistry', () => {
  test('register + get round-trip', () => {
    const registry = new SchemaRegistry()
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    registry.register(user)
    expect(registry.get('user')).toBe(user)
    expect(registry.has('user')).toBe(true)
  })

  test('register throws on duplicate name', () => {
    const registry = new SchemaRegistry()
    registry.register(defineSchema('user', Archetype.Entity, (t) => t.id()))
    expect(() => registry.register(defineSchema('user', Archetype.Entity, (t) => t.id()))).toThrow(
      ConfigError,
    )
  })

  test('registerAll registers many', () => {
    const registry = new SchemaRegistry()
    registry.registerAll([
      defineSchema('user', Archetype.Entity, (t) => t.id()),
      defineSchema('lead', Archetype.Entity, (t) => t.id()),
    ])
    expect(registry.all().map((s) => s.name)).toEqual(['user', 'lead'])
  })

  test('getOrFail throws on missing', () => {
    const registry = new SchemaRegistry()
    expect(() => registry.getOrFail('missing')).toThrow(/no schema registered/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isSchema — type-guard used by discover()
// ─────────────────────────────────────────────────────────────────────────────

describe('isSchema', () => {
  test('returns true for a defineSchema result', () => {
    const s = defineSchema('demo', Archetype.Entity, (t) => t.id())
    expect(isSchema(s)).toBe(true)
  })

  test('rejects non-objects', () => {
    expect(isSchema(null)).toBe(false)
    expect(isSchema(undefined)).toBe(false)
    expect(isSchema('schema')).toBe(false)
    expect(isSchema(42)).toBe(false)
  })

  test('rejects POJOs missing required fields', () => {
    expect(isSchema({})).toBe(false)
    expect(isSchema({ name: 'foo' })).toBe(false)
    expect(isSchema({ name: 'foo', archetype: 'not-a-real-archetype' })).toBe(false)
    expect(isSchema({ name: 'foo', archetype: Archetype.Entity })).toBe(false) // missing fields/tenancy/relations
  })

  test('rejects an empty-string name', () => {
    const fake = {
      name: '',
      archetype: Archetype.Entity,
      fields: [],
      tenancy: {},
      relations: [],
    }
    expect(isSchema(fake)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SchemaRegistry.discover — Bun.Glob + dynamic import
// ─────────────────────────────────────────────────────────────────────────────

describe('SchemaRegistry.discover', () => {
  test('picks up every schema export from matching files', async () => {
    const registry = new SchemaRegistry()
    await registry.discover('auto_discover_schemas/{user_schema,post_schema}.ts', {
      cwd: FIXTURES_CWD,
    })
    const names = registry
      .all()
      .map((s) => s.name)
      .sort()
    expect(names).toEqual(['post_fixture', 'user_fixture'])
  })

  test('ignores files whose exports are not Schema-shaped', async () => {
    const registry = new SchemaRegistry()
    await registry.discover('auto_discover_schemas/helper.ts', { cwd: FIXTURES_CWD })
    expect(registry.all()).toEqual([])
  })

  test('the same Schema instance seen via a barrel re-export is deduplicated', async () => {
    const registry = new SchemaRegistry()
    // The barrel re-exports userSchema TWICE (once as `userSchema`, once as
    // `renamedUserSchema`) plus the postSchema. Combined with user_schema.ts
    // and post_schema.ts the same instances are reachable through 3 + 3 import
    // paths. Discover should land each instance exactly once.
    await registry.discover('auto_discover_schemas/*.ts', { cwd: FIXTURES_CWD })
    expect(
      registry
        .all()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['post_fixture', 'user_fixture'])
  })

  test('returns `this` for chaining', async () => {
    const registry = new SchemaRegistry()
    const returned = await registry.discover('auto_discover_schemas/user_schema.ts', {
      cwd: FIXTURES_CWD,
    })
    expect(returned).toBe(registry)
  })

  test('accepts an array of patterns', async () => {
    const registry = new SchemaRegistry()
    await registry.discover(
      ['auto_discover_schemas/user_schema.ts', 'auto_discover_schemas/post_schema.ts'],
      { cwd: FIXTURES_CWD },
    )
    expect(
      registry
        .all()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['post_fixture', 'user_fixture'])
  })

  test('different schemas sharing a name still throw (programmer error preserved)', async () => {
    const registry = new SchemaRegistry()
    // Pre-register a schema named "user_fixture" so the discovered file's
    // export collides.
    registry.register(defineSchema('user_fixture', Archetype.Entity, (t) => t.id()))
    await expect(
      registry.discover('auto_discover_schemas/user_schema.ts', { cwd: FIXTURES_CWD }),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  test('no matching files → registry unchanged, no throw', async () => {
    const registry = new SchemaRegistry()
    await registry.discover('auto_discover_schemas/nope_*.ts', { cwd: FIXTURES_CWD })
    expect(registry.all()).toEqual([])
  })
})
