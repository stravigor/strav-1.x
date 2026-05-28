/**
 * Model decorators — change in-memory shape or serialization behavior
 * without altering the underlying schema/DDL.
 *
 * V1 ships `@hidden`. The rest of the serialization slice (`@cast`,
 * `@encrypt`, `@ulid`) lands incrementally on top of this same metadata
 * pattern.
 *
 * Mechanism: each decorator stashes a Set of field names on the class
 * constructor (under a Symbol). The Model base class reads those sets
 * during `toJSON()` / hydration. Subclasses inherit the Sets via the
 * class-static prototype chain — but when a subclass adds its OWN
 * decorated field, we reseed a new Set on the subclass so the parent's
 * Set stays untouched.
 */

/** Symbol key for the per-class set of @hidden field names. */
export const HIDDEN_FIELDS = Symbol.for('@strav/database/HIDDEN_FIELDS')

/** Symbol key for the per-class @cast field map. */
export const CAST_FIELDS = Symbol.for('@strav/database/CAST_FIELDS')

/** Internal — shape we expect on classes that hold @hidden metadata. */
type WithHidden = { [HIDDEN_FIELDS]?: Set<string> }

/** Internal — shape we expect on classes that hold @cast metadata. */
type WithCasts = { [CAST_FIELDS]?: Map<string, FieldCaster> }

/**
 * Mark a Model property as hidden from `toJSON()` (and therefore from
 * `JSON.stringify(model)`). Use for secrets, server-internal columns,
 * or anything an API response shouldn't leak.
 *
 * ```ts
 * class User extends Model {
 *   static schema = userSchema
 *   id!: string
 *   email!: string
 *   @hidden password_hash!: string   // ← omitted from JSON output
 * }
 * ```
 *
 * Inheritance: if a parent class has `@hidden` fields, subclasses see
 * them too. If the subclass adds its own `@hidden`, the parent's set
 * stays untouched (own-property check + reseed).
 */
export function hidden(target: object, propertyKey: string | symbol): void {
  const ctor = target.constructor as WithHidden
  if (!Object.hasOwn(ctor, HIDDEN_FIELDS)) {
    // Seed from any inherited set (walks the static prototype chain) so
    // subclasses don't lose parent-declared hidden fields, but don't
    // share the Set instance.
    const inherited = ctor[HIDDEN_FIELDS]
    Object.defineProperty(ctor, HIDDEN_FIELDS, {
      value: new Set<string>(inherited ?? []),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
  ctor[HIDDEN_FIELDS]?.add(String(propertyKey))
}

/** Read the set of @hidden field names for a class (walks the static chain). */
export function hiddenFieldsOf(ctor: object): ReadonlySet<string> {
  return (ctor as WithHidden)[HIDDEN_FIELDS] ?? EMPTY_SET
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_CASTS: ReadonlyMap<string, FieldCaster> = new Map()

/**
 * Bidirectional cast spec for a single field. `fromDb` transforms raw DB
 * values on hydration (Postgres row → Model field). `toDb` transforms
 * Model values on write (Model field → INSERT/UPDATE param). Either side
 * is optional — apps that only need one direction (e.g., a one-way enum
 * → Date parse) omit the other.
 */
export interface FieldCaster<DbValue = unknown, ModelValue = unknown> {
  fromDb?: (value: DbValue) => ModelValue
  toDb?: (value: ModelValue) => DbValue
}

/**
 * Mark a Model property with a bidirectional cast. `fromDb` runs when
 * the Repository hydrates a row from the DB; `toDb` runs on `create` /
 * `update` before the SQL emitter sees the value.
 *
 * ```ts
 * class Order extends Model {
 *   static schema = orderSchema
 *   @cast({ fromDb: (v: string) => new Money(v), toDb: (m: Money) => m.toString() })
 *   total!: Money
 * }
 * ```
 *
 * Inheritance: subclasses inherit parent casts. Adding a `@cast` on a
 * subclass reseeds the Map (no parent mutation). A subclass casting
 * the SAME field name overrides the parent's caster for that field.
 */
export function cast<DbValue = unknown, ModelValue = unknown>(
  spec: FieldCaster<DbValue, ModelValue>,
): (target: object, propertyKey: string | symbol) => void {
  return (target, propertyKey) => {
    const ctor = target.constructor as WithCasts
    if (!Object.hasOwn(ctor, CAST_FIELDS)) {
      const inherited = ctor[CAST_FIELDS]
      Object.defineProperty(ctor, CAST_FIELDS, {
        value: new Map<string, FieldCaster>(inherited ?? []),
        writable: false,
        configurable: false,
        enumerable: false,
      })
    }
    ctor[CAST_FIELDS]?.set(String(propertyKey), spec as FieldCaster)
  }
}

/** Read the map of @cast field casters for a class (walks the static chain). */
export function castsFor(ctor: object): ReadonlyMap<string, FieldCaster> {
  return (ctor as WithCasts)[CAST_FIELDS] ?? EMPTY_CASTS
}

/** Single-field cast accessor — convenience over `castsFor(ctor).get(name)`. */
export function castFor(ctor: object, fieldName: string): FieldCaster | undefined {
  return castsFor(ctor).get(fieldName)
}

/**
 * Apply `toDb` on every cast-decorated field in `attrs`, returning a fresh
 * object. Fields without a caster — or fields whose value is `undefined`
 * — pass through unchanged.
 */
export function applyCastsToDb(
  ctor: object,
  attrs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const casts = castsFor(ctor)
  if (casts.size === 0) return { ...attrs }
  const out: Record<string, unknown> = { ...attrs }
  for (const [name, caster] of casts) {
    if (!caster.toDb) continue
    if (!Object.hasOwn(out, name)) continue
    const value = out[name]
    if (value === undefined) continue
    out[name] = caster.toDb(value)
  }
  return out
}
