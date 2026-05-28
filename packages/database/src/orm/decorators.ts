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

/** Internal — shape we expect on classes that hold @hidden metadata. */
type WithHidden = { [HIDDEN_FIELDS]?: Set<string> }

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
