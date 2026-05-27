import { describe, expect, test } from 'bun:test'
import { ConfigError } from '@strav/kernel'
import { Archetype, defineSchema, SchemaRegistry } from '../src/index.ts'

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
