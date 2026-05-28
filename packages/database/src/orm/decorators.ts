/**
 * Model decorators — change in-memory shape, serialization, or write-path
 * behavior without altering the underlying schema/DDL.
 *
 * V1 ships `@hidden`, `@cast`, and `@ulid`. `@encrypt` lands in a
 * follow-up slice (it needs a Cipher service wired through DI).
 *
 * Mechanism: each decorator stashes a Set or Map of field names on the
 * class constructor (under a Symbol). The Model base class (or
 * Repository) reads those sets during `toJSON()` / hydration / write.
 * Subclasses inherit the Sets via the class-static prototype chain —
 * but when a subclass adds its OWN decorated field, we reseed a new
 * Set/Map on the subclass so the parent's metadata stays untouched.
 */

import { type Cipher, ulid as generateUlid, isUlid, ValidationError } from '@strav/kernel'

/** Symbol key for the per-class set of @hidden field names. */
export const HIDDEN_FIELDS = Symbol.for('@strav/database/HIDDEN_FIELDS')

/** Symbol key for the per-class @cast field map. */
export const CAST_FIELDS = Symbol.for('@strav/database/CAST_FIELDS')

/** Symbol key for the per-class set of @ulid field names. */
export const ULID_FIELDS = Symbol.for('@strav/database/ULID_FIELDS')

/** Symbol key for the per-class set of @encrypt field names. */
export const ENCRYPT_FIELDS = Symbol.for('@strav/database/ENCRYPT_FIELDS')

/** Internal — shape we expect on classes that hold @hidden metadata. */
type WithHidden = { [HIDDEN_FIELDS]?: Set<string> }

/** Internal — shape we expect on classes that hold @cast metadata. */
type WithCasts = { [CAST_FIELDS]?: Map<string, FieldCaster> }

/** Internal — shape we expect on classes that hold @ulid metadata. */
type WithUlids = { [ULID_FIELDS]?: Set<string> }

/** Internal — shape we expect on classes that hold @encrypt metadata. */
type WithEncrypted = { [ENCRYPT_FIELDS]?: Set<string> }

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

/**
 * Mark a Model property as a ULID-shaped string. On `Repository.create`,
 * the decorator auto-fills the column with a fresh ULID when the
 * caller didn't supply one — mirroring the auto-PK behavior of
 * `t.id()`, but available for any string column (correlation IDs,
 * batch IDs, external refs). On both create and update, any
 * user-supplied value is validated as a well-formed 26-character
 * Crockford-base32 ULID; non-ULIDs throw a `ValidationError` at the
 * application boundary rather than letting Postgres reject a too-short
 * / too-long string at INSERT/UPDATE time.
 *
 * ```ts
 * class Job extends Model {
 *   static schema = jobSchema
 *   id!: string
 *   @ulid correlation_id!: string   // auto-generated on create if unset
 * }
 * ```
 *
 * The decorator is write-side only — hydration is passthrough since the
 * column is already `char(26)` at the DB layer (no malformed reads
 * possible). Putting `@ulid` on the PK `id` field is redundant (the
 * SQL emitter auto-generates `id` for `t.id()` schemas) but harmless:
 * the decorator-supplied id is forwarded to `emitInsert`, which then
 * sees a value and skips its own auto-generation.
 *
 * Inheritance: same rules as `@hidden` / `@cast`. Subclasses inherit
 * parent ULID fields; adding `@ulid` on a subclass reseeds the Set so
 * the parent's metadata stays untouched.
 */
export function ulid(target: object, propertyKey: string | symbol): void {
  const ctor = target.constructor as WithUlids
  if (!Object.hasOwn(ctor, ULID_FIELDS)) {
    const inherited = ctor[ULID_FIELDS]
    Object.defineProperty(ctor, ULID_FIELDS, {
      value: new Set<string>(inherited ?? []),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
  ctor[ULID_FIELDS]?.add(String(propertyKey))
}

/** Read the set of @ulid field names for a class (walks the static chain). */
export function ulidFieldsOf(ctor: object): ReadonlySet<string> {
  return (ctor as WithUlids)[ULID_FIELDS] ?? EMPTY_SET
}

/**
 * Apply the @ulid contract to an attrs object before it reaches the
 * SQL emitter. Returns a fresh object — never mutates the input.
 *
 *   - mode `'create'`: fields absent (or explicitly `undefined`) in
 *     attrs are auto-filled with a fresh ULID; present values are
 *     validated.
 *   - mode `'update'`: only validates fields that are present in
 *     attrs. Updates never auto-generate — a missing field means "no
 *     change," and re-rolling a stable identifier mid-life would be a
 *     bug.
 *
 * `null` is treated as "no value" — same as undefined — because
 * Postgres `null` is the only way the DB stores "no ULID here" for
 * nullable columns. On create, that triggers auto-generation; on
 * update, the null is forwarded unchanged so the caller can explicitly
 * clear a nullable ULID column.
 *
 * Validation failures throw a `ValidationError` carrying a field-level
 * `errors` map keyed by the offending column name — fits the same
 * surface HTTP responses already serialize.
 */
export function applyUlidsToAttrs(
  ctor: object,
  attrs: Readonly<Record<string, unknown>>,
  mode: 'create' | 'update',
): Record<string, unknown> {
  const fields = ulidFieldsOf(ctor)
  if (fields.size === 0) return { ...attrs }
  const out: Record<string, unknown> = { ...attrs }
  for (const name of fields) {
    const value = Object.hasOwn(out, name) ? out[name] : undefined
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !isUlid(value)) {
        throw new ValidationError(`@ulid field "${name}" is not a valid ULID.`, {
          code: 'database.ulid.invalid',
          context: { field: name, value },
          errors: {
            [name]: ['must be a 26-character Crockford-base32 ULID'],
          },
        })
      }
      continue
    }
    // value is undefined or null. On create, both mean "fill me in". On
    // update, only null is a meaningful caller-supplied "clear it"
    // signal — undefined means the field was omitted entirely.
    if (mode === 'create') {
      out[name] = generateUlid()
    }
  }
  return out
}

/**
 * Mark a Model property as encrypted-at-rest. The Repository runs the
 * Cipher's `encrypt` on every `@encrypt` field after `@cast.toDb` (so
 * casts that normalize the model value into its storage string get to
 * run first), and runs `decrypt` on hydration before `@cast.fromDb`.
 *
 * The decorated field is a `string` on the Model side and `bytea` in
 * Postgres (declare the schema column as `t.encrypted('field_name')`).
 * Storage layout — `iv (12) || tag (16) || ct` — comes from
 * `AesGcm256Cipher`; the auth tag means tampered ciphertext loud-fails
 * at read instead of silently decrypting garbage.
 *
 * ```ts
 * class User extends Model {
 *   static schema = userSchema
 *   id!: string
 *   email!: string
 *   @encrypt ssn!: string      // bytea in Postgres, string in memory
 * }
 * ```
 *
 * If the Repository was constructed without a Cipher (no
 * `EncryptionProvider` registered) and the Model has `@encrypt`
 * fields, the first encrypt/decrypt call throws `ConfigError` —
 * loud-fail rather than silent passthrough.
 *
 * Inheritance: same own-property reseed pattern as `@hidden` / `@cast`
 * / `@ulid` — subclasses inherit parent encrypted fields; adding
 * `@encrypt` on a subclass reseeds the Set without touching the
 * parent's metadata.
 */
export function encrypt(target: object, propertyKey: string | symbol): void {
  const ctor = target.constructor as WithEncrypted
  if (!Object.hasOwn(ctor, ENCRYPT_FIELDS)) {
    const inherited = ctor[ENCRYPT_FIELDS]
    Object.defineProperty(ctor, ENCRYPT_FIELDS, {
      value: new Set<string>(inherited ?? []),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
  ctor[ENCRYPT_FIELDS]?.add(String(propertyKey))
}

/** Read the set of @encrypt field names for a class (walks the static chain). */
export function encryptedFieldsOf(ctor: object): ReadonlySet<string> {
  return (ctor as WithEncrypted)[ENCRYPT_FIELDS] ?? EMPTY_SET
}

/**
 * Encrypt every `@encrypt`-decorated field in `attrs` using `cipher`.
 * Returns a fresh object; never mutates the input. Fields absent /
 * `undefined` / `null` pass through unchanged. Non-string values throw
 * `ValidationError` — the decorator's contract is that the storage
 * value is a string at this point (any model-side coercion belongs in
 * `@cast.toDb`, which runs first).
 */
export function applyEncryptToAttrs(
  ctor: object,
  attrs: Readonly<Record<string, unknown>>,
  cipher: Cipher,
): Record<string, unknown> {
  const fields = encryptedFieldsOf(ctor)
  if (fields.size === 0) return { ...attrs }
  const out: Record<string, unknown> = { ...attrs }
  for (const name of fields) {
    if (!Object.hasOwn(out, name)) continue
    const value = out[name]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      throw new ValidationError(`@encrypt field "${name}" must be a string before encryption.`, {
        code: 'database.encrypt.not-string',
        context: { field: name },
        errors: { [name]: ['must be a string at the storage boundary'] },
      })
    }
    out[name] = cipher.encrypt(value)
  }
  return out
}

/**
 * Decrypt every `@encrypt`-decorated field on a hydrated row using
 * `cipher`. Returns a fresh row object; never mutates the input. Fields
 * that come back as `null` (nullable encrypted columns) pass through.
 * Non-bytea values surface as `ConfigError` — that shape mismatch is a
 * schema/data integrity bug, not a user-input problem.
 */
export function applyDecryptToRow(
  ctor: object,
  row: Readonly<Record<string, unknown>>,
  cipher: Cipher,
): Record<string, unknown> {
  const fields = encryptedFieldsOf(ctor)
  if (fields.size === 0) return { ...row }
  const out: Record<string, unknown> = { ...row }
  for (const name of fields) {
    const value = out[name]
    if (value === undefined || value === null) continue
    let bytes: Uint8Array
    if (value instanceof Uint8Array) {
      bytes = value
    } else if (Buffer.isBuffer(value)) {
      bytes = Uint8Array.from(value)
    } else {
      throw new TypeError(
        `@encrypt field "${name}": expected bytea (Uint8Array / Buffer) on hydration, got ${typeof value}.`,
      )
    }
    out[name] = cipher.decrypt(bytes)
  }
  return out
}
