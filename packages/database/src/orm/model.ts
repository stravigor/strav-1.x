/**
 * `Model` — the plain typed entity.
 *
 * Per `spec/orm-and-repositories.md`: data access is explicit and
 * injectable. Models hold fields + optional accessors; they do not have
 * static query methods, a `save()`, or a connection. Persistence is the
 * Repository's job.
 *
 * Apps subclass `Model` and assign `static schema = userSchema` so the
 * Repository knows which schema to map rows against.
 *
 * Decorators (`@encrypt`, `@hidden`, `@cast`, `@ulid`) land with the
 * encryption + serialization slice; this foundation slice keeps the class
 * minimal — Repository hydrates by copying schema-declared columns onto a
 * fresh instance.
 */

import type { Schema } from '../schema/types.ts'

export interface ModelClass<T extends Model = Model> {
  /** Required — the schema this Model maps to. Set by the subclass. */
  schema: Schema
  new (): T
}

// biome-ignore lint/complexity/noStaticOnlyClass: Model is the subclass-extension base — the static `schema` is a Schema-link contract every concrete Model fulfills, not a namespace for static helpers.
export class Model {
  /**
   * Set by every concrete subclass. Read by the Repository to know the
   * table name + field metadata. Type widened to `undefined` so subclasses
   * can supply the literal schema without TS structural-mismatch noise.
   */
  static readonly schema: Schema | undefined
}

/**
 * Hydrate `target` (a fresh instance or POJO) from a DB row by copying
 * every schema-declared column whose value is present. Unknown columns are
 * dropped; the Schema is the contract.
 *
 * Repository uses this internally; exposed for advanced cases (writing a
 * custom query result type that bypasses the Repository).
 */
export function hydrateRow<T extends object>(
  schema: Schema,
  row: Record<string, unknown>,
  target: T,
): T {
  for (const field of schema.fields) {
    if (Object.hasOwn(row, field.name)) {
      ;(target as Record<string, unknown>)[field.name] = row[field.name]
    }
  }
  return target
}

/** Type-guard for ModelClass — used when the Repository validates its subclass. */
export function isModelClass(value: unknown): value is ModelClass {
  return (
    typeof value === 'function' &&
    typeof (value as { schema?: unknown }).schema === 'object' &&
    (value as { schema?: Schema }).schema !== null
  )
}
