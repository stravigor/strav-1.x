/**
 * `SchemaRegistry` — the runtime catalog of every registered `Schema`.
 *
 * Apps register schemas either explicitly in a provider (the
 * `register(schema)` / `registerAll(schemas)` API) or via auto-discovery
 * (`await discover('database/schemas/**\/*.ts')`), which uses `Bun.Glob`
 * to scan + dynamically `import()` each file and registers every export
 * that satisfies the `Schema` shape.
 *
 * The registry rejects duplicates by name so two schemas can't claim the
 * same DB table — except when auto-discovery sees the same schema
 * instance via multiple import paths (a barrel re-export), which is
 * benign and silently skipped.
 */

import { ConfigError } from '@strav/kernel'
import { Archetype, type Schema } from './schema/types.ts'

export class SchemaRegistry {
  private readonly schemas = new Map<string, Schema>()

  /** Register one schema. Throws on duplicate `name`. */
  register(schema: Schema): this {
    if (this.schemas.has(schema.name)) {
      throw new ConfigError(
        `SchemaRegistry: schema "${schema.name}" is already registered. ` +
          'Schema names map 1:1 to DB tables — pick a different name.',
      )
    }
    this.schemas.set(schema.name, schema)
    return this
  }

  /** Register many at once — convenience. */
  registerAll(schemas: readonly Schema[]): this {
    for (const s of schemas) this.register(s)
    return this
  }

  /**
   * Auto-discover schemas by glob pattern. For each matched file:
   *   1. dynamically `import()` it,
   *   2. iterate every exported value,
   *   3. register every one that satisfies {@link isSchema}.
   *
   * `pattern` is a `Bun.Glob`-compatible string (or array). `cwd`
   * defaults to `process.cwd()` — typically the repo root. Returns
   * `this` for chaining.
   *
   * Re-exports of the same schema instance via multiple files (e.g.
   * a barrel) are seen multiple times but only registered once — the
   * registry deduplicates by object identity, NOT by name. A different
   * schema sharing a name with an already-registered one still throws
   * (programmer error: two tables can't claim the same name).
   *
   * ```ts
   * // Typical wiring in a schemas provider's boot():
   * await registry.discover('database/schemas/**\/*.ts')
   * ```
   *
   * Files that export no schemas (helpers, type-only re-exports) are
   * silently skipped — discover() is a low-friction "register everything
   * that looks like a schema" pass.
   */
  async discover(pattern: string | string[], options: { cwd?: string } = {}): Promise<this> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const cwd = options.cwd ?? process.cwd()
    const files = new Set<string>()
    for (const p of patterns) {
      const glob = new Bun.Glob(p)
      for await (const file of glob.scan({ cwd, absolute: true })) {
        files.add(file)
      }
    }
    for (const file of files) {
      const mod = (await import(file)) as Record<string, unknown>
      for (const value of Object.values(mod)) {
        if (!isSchema(value)) continue
        const existing = this.schemas.get(value.name)
        if (existing === value) continue
        // Different instance with the same name — let register() throw the
        // standard "already registered" error.
        this.register(value)
      }
    }
    return this
  }

  /** Resolve by name. Returns `undefined` for unknown names. */
  get(name: string): Schema | undefined {
    return this.schemas.get(name)
  }

  /** Throwing variant — use when "this schema must exist" is a hard precondition. */
  getOrFail(name: string): Schema {
    const schema = this.schemas.get(name)
    if (!schema) {
      throw new ConfigError(`SchemaRegistry: no schema registered under "${name}".`)
    }
    return schema
  }

  has(name: string): boolean {
    return this.schemas.has(name)
  }

  /** Every registered schema, in registration order. */
  all(): readonly Schema[] {
    return [...this.schemas.values()]
  }

  /** Test helper: wipe the registry. */
  clear(): void {
    this.schemas.clear()
  }
}

/**
 * Type-guard: a value looks like a `Schema`. Used by `discover()` to
 * filter exported values; conservative (checks every load-bearing
 * field's shape) so a stray POJO can't accidentally land in the
 * registry.
 *
 * Exported so apps can hand-roll their own discovery loops if the
 * built-in `discover()` doesn't fit (e.g. globbing a remote source).
 */
export function isSchema(value: unknown): value is Schema {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.name !== 'string' || v.name === '') return false
  if (!Object.values(Archetype).includes(v.archetype as Archetype)) return false
  if (!Array.isArray(v.fields)) return false
  if (v.tenancy === null || typeof v.tenancy !== 'object') return false
  if (!Array.isArray(v.relations)) return false
  return true
}
