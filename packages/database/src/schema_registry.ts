/**
 * `SchemaRegistry` — the runtime catalog of every registered `Schema`.
 *
 * Apps register schemas in a provider (typically `app/providers/schemas_
 * provider.ts`) that depends on `'database'`. Auto-discovery via `Bun.Glob`
 * over `database/schemas/**.ts` is a follow-up — the manual API is the
 * authoritative path today.
 *
 * The registry rejects duplicates by name so two schemas can't claim the
 * same DB table.
 */

import { ConfigError } from '@strav/kernel'
import type { Schema } from './schema/types.ts'

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
