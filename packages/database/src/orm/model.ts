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
 * Decorators (all shipped, all on the same `Symbol.for`-keyed
 * metadata pattern): `@hidden` (omit from `toJSON()`), `@cast`
 * (bidirectional DB↔Model type coercion), `@ulid` (auto-mint +
 * validate ULID columns), `@encrypt` (encryption-at-rest via Cipher).
 */

import type { Cipher } from '@strav/kernel'
import type { Schema } from '../schema/types.ts'
import { applyDecryptToRow, castsFor, hiddenFieldsOf } from './decorators.ts'

export interface ModelClass<T extends object = Model> {
  /** Required — the schema this Model maps to. Set by the subclass. */
  schema: Schema
  new (): T
}

export class Model {
  /**
   * Set by every concrete subclass. Read by the Repository to know the
   * table name + field metadata. Type widened to `undefined` so subclasses
   * can supply the literal schema without TS structural-mismatch noise.
   */
  static readonly schema: Schema | undefined

  /**
   * Default `toJSON()` — JSON.stringify uses this. Walks own enumerable
   * properties on the instance, omits any marked `@hidden` on the class
   * (or any ancestor class). Subclasses that need custom serialization
   * override this method; the override loses the auto-omission unless it
   * calls `super.toJSON()` first.
   */
  toJSON(): Record<string, unknown> {
    const hidden = hiddenFieldsOf(this.constructor as object)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(this)) {
      if (!hidden.has(key)) {
        out[key] = (this as unknown as Record<string, unknown>)[key]
      }
    }
    return out
  }
}

/**
 * Hydrate `target` (a fresh instance or POJO) from a DB row by copying
 * every schema-declared column whose value is present. Unknown columns are
 * dropped; the Schema is the contract.
 *
 * Repository uses this internally; exposed for advanced cases (writing a
 * custom query result type that bypasses the Repository).
 *
 * Decoration order:
 *   1. `@encrypt` fields are decrypted via `cipher` (when supplied) — so
 *      subsequent steps see the plaintext string, not the bytea blob.
 *   2. Schema-declared columns are copied onto the target.
 *   3. `@cast` `fromDb` transforms run on each populated field — they
 *      see the decrypted-then-copied string and can wrap it in a value
 *      object if they want.
 *
 * Pure-POJO hydration (no class on the target) skips the decorator
 * steps — the Schema is still the contract. The `cipher` parameter is
 * optional: only Models with `@encrypt` fields need it, and the
 * Repository passes it through when constructed with one.
 */
export function hydrateRow<T extends object>(
  schema: Schema,
  row: Record<string, unknown>,
  target: T,
  cipher?: Cipher,
): T {
  const obj = target as Record<string, unknown>
  const ctor = (target as { constructor?: object }).constructor
  // Decrypt @encrypt fields up-front so the column-copy + cast.fromDb
  // steps see the decrypted plaintext.
  const source = ctor && cipher ? applyDecryptToRow(ctor, row, cipher) : row
  for (const field of schema.fields) {
    if (Object.hasOwn(source, field.name)) {
      obj[field.name] = source[field.name]
    }
  }
  if (ctor) {
    const casts = castsFor(ctor)
    if (casts.size > 0) {
      for (const [name, caster] of casts) {
        if (!caster.fromDb) continue
        if (!Object.hasOwn(obj, name)) continue
        obj[name] = caster.fromDb(obj[name])
      }
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
