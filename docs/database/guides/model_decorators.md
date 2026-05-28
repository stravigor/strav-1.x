# Model decorators

Model decorators change in-memory shape, serialization, or write-path behavior without altering the underlying schema or DDL. V1 ships `@hidden`, `@cast`, `@ulid`, and `@encrypt`.

## `@hidden` — omit from `toJSON()`

Mark sensitive or server-internal fields. `JSON.stringify(model)` won't include them — and since most response serializers call `toJSON()`, API responses are safe by construction.

```ts
import { hidden, Model } from '@strav/database'

class User extends Model {
  static schema = userSchema
  id!: string
  email!: string
  @hidden password_hash!: string    // never leaves the server in JSON
  created_at!: Date
  updated_at!: Date
}

const user = new User()
user.id = '01HZ…'
user.email = 'a@b.com'
user.password_hash = 'argon2-hash'

JSON.stringify(user)
// → '{"id":"01HZ…","email":"a@b.com","created_at":…,"updated_at":…}'
```

`AccessToken.hash` is decorated `@hidden` in the framework — token-list endpoints don't leak the stored SHA-256 hash. Apps building their own User / Account models should decorate `password_hash` (or whatever the secret-credential column is named) the same way.

### Inheritance

Subclasses inherit `@hidden` fields from the parent. Subclasses that add their own `@hidden` get a fresh Set (no mutation of the parent's set), seeded with whatever the parent already declared:

```ts
class User extends Model {
  @hidden password_hash!: string
}
class AuditedUser extends User {
  @hidden internal_audit_token!: string
}
// AuditedUser hides both fields; User still hides only password_hash.
```

### Custom `toJSON` overrides

If a Model subclass needs custom serialization, override `toJSON()` directly. The base implementation does the @hidden filtering — call `super.toJSON()` to preserve that, then mutate:

```ts
class User extends Model {
  @hidden password_hash!: string

  override toJSON(): Record<string, unknown> {
    const base = super.toJSON()
    return { ...base, displayName: this.email.split('@')[0] }
  }
}
```

### Reading the metadata at runtime

`hiddenFieldsOf(ModelClass)` returns the `ReadonlySet<string>` of decorated names. Useful for response serializers that need to filter at boundaries other than `toJSON()`:

```ts
import { hiddenFieldsOf } from '@strav/database'

const hidden = hiddenFieldsOf(User)
// → Set { 'password_hash' }
```

## `@cast` — bidirectional type coercion

Maps between the DB column type and an in-memory Model type. `fromDb` runs on hydration (DB → Model); `toDb` runs on `create` / `update` before the SQL emitter sees the value. Useful for custom value objects, jsonb-as-string transformations on non-Bun drivers, or any time the Model field type differs from the column's storage type.

```ts
import { cast, Model } from '@strav/database'

class Money {
  constructor(readonly amount: number) {}
  static fromString(s: string) { return new Money(Number.parseFloat(s)) }
  toString() { return this.amount.toFixed(2) }
}

class Order extends Model {
  static schema = orderSchema
  id!: string
  @cast({
    fromDb: (raw: unknown) => Money.fromString(String(raw)),
    toDb:   (m: unknown) => (m as Money).toString(),
  })
  total!: Money
}

// On read: Repository.find('o-1').total is a Money instance.
// On write: Repository.create({ total: new Money(50) }) sends '50.00' to Postgres.
```

Either side of the cast is optional — apps that only need one direction (e.g., parse on read, store as-is) omit the other.

### Inheritance

Same own-property reseed pattern as `@hidden`. Subclasses inherit parent casts; adding a `@cast` on the subclass reseeds a new Map (parent's stays untouched); decorating the SAME field name on a subclass overrides the parent's caster for that field.

### Helpers

- `castFor(ModelClass, fieldName)` — the `FieldCaster` for a single field, or `undefined`.
- `castsFor(ModelClass)` — the full `ReadonlyMap<string, FieldCaster>` for runtime inspection.
- `applyCastsToDb(ModelClass, attrs)` — returns a fresh object with every decorated field's `toDb` applied. Repository uses it internally; exposed for custom paths.

## `@ulid` — auto-generate + validate ULID columns

Mark a Model property as a ULID-shaped string. The decorator extends the auto-PK behavior of `t.id()` to any string column, so non-PK ULIDs (correlation IDs, batch IDs, external refs) get the same automatic-mint-on-create + format-validate-on-write treatment as the primary key.

```ts
import { ulid, Model } from '@strav/database'

class Job extends Model {
  static schema = jobSchema
  id!: string
  @ulid correlation_id!: string
  status!: string
}

// On create: correlation_id is filled in automatically.
await jobRepo.create({ status: 'pending' })
// → INSERT INTO "job" ("id", "correlation_id", "status") VALUES ($1, $2, $3)
//   with $2 = '01HZ8N3ZQVYJEXMP9YK0F0F0F0' (freshly generated)

// On create with a caller-supplied ULID: validated, passed through.
await jobRepo.create({ correlation_id: '01HZ…', status: 'pending' })

// On create with a bad value: ValidationError before any SQL is emitted.
await jobRepo.create({ correlation_id: 'not-a-ulid', status: 'pending' })
// → throws ValidationError { errors: { correlation_id: ['must be a 26-character Crockford-base32 ULID'] } }

// On update: validates if present, never auto-generates.
await jobRepo.update(job, { correlation_id: '01HZ…' })   // validated
await jobRepo.update(job, { status: 'done' })            // correlation_id untouched
```

### Semantics

| Mode | Field absent or `undefined` | Field is `null` | Field has a value |
|---|---|---|---|
| `create` | auto-generate fresh ULID | auto-generate fresh ULID | validate; reject non-ULID |
| `update` | leave alone | forward `null` (caller is clearing) | validate; reject non-ULID |

Validation throws `ValidationError` (from `@strav/kernel`) with a field-level `errors` map keyed by the offending column name — the same shape HTTP responses already serialize, so no extra mapping in error-handling middleware.

The decorator is write-side only — hydration is passthrough. The column is `char(26)` at the DB layer, so reads can't produce malformed rows.

### Order of operations

The Repository runs `@ulid` **before** `@cast` on writes, so casts see the auto-generated (or caller-supplied) ULID string rather than `undefined`. Hydration (`fromDb`) uses `@cast` only — `@ulid` doesn't participate in reads.

### Combining with the PK auto-ULID

Putting `@ulid` on the PK `id` field is redundant — the SQL emitter already auto-generates `id` for `t.id()` schemas — but it's harmless. The decorator-supplied id is forwarded to `emitInsert`, which sees a value and skips its own auto-generation. Use `@ulid` for non-PK ULID columns; let `t.id()` handle the PK.

### Inheritance

Same own-property reseed pattern as `@hidden` and `@cast`. Subclasses inherit parent ULID fields; adding `@ulid` on the subclass reseeds a fresh Set so the parent's metadata stays untouched.

### Helpers

- `ulidFieldsOf(ModelClass)` — `ReadonlySet<string>` of decorated field names.
- `applyUlidsToAttrs(ModelClass, attrs, mode)` — returns a fresh object with auto-fill + validation applied. Repository uses it internally; exposed for custom write paths.

## `@encrypt` — encryption-at-rest

Mark a Model property as encrypted in the DB. The column type is `bytea` (declare with `t.encrypted('field_name')`); the value stays a plain string on the Model side. The Repository runs `Cipher.encrypt` on every `@encrypt` field before INSERT/UPDATE, and `Cipher.decrypt` on hydration. AES-256-GCM is the default cipher — authenticated, so tampered ciphertext or a wrong key loud-fails at decrypt time instead of silently producing garbage.

```ts
import { encrypt, Model } from '@strav/database'

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email')
  t.encrypted('ssn')       // ← bytea column
  t.timestamps()
})

class User extends Model {
  static schema = userSchema
  id!: string
  email!: string
  @encrypt ssn!: string    // ← string in memory, bytea on disk
}
```

### Setup

Apps that use `@encrypt` need to register `EncryptionProvider` (from `@strav/kernel`) and ship a key in config:

```ts
// config/encryption.ts
import { env } from '@strav/kernel'

export default {
  // 32 bytes — hex (64 chars) or base64 (44 chars padded).
  // Generate one with: `openssl rand -hex 32`.
  key: env.required('ENCRYPTION_KEY'),
}

// bootstrap/providers.ts
new ConfigProvider({ encryption: encryptionConfig, ... }),
new EncryptionProvider(),
```

A malformed key (wrong length, bad encoding) throws `ConfigError` at boot — fail-fast rather than midway through the first encrypted write. A model with `@encrypt` fields constructed without `EncryptionProvider` registered throws on the first `create` / `update` / `find` call.

### Write path

```ts
await userRepo.create({ id: 'u-1', email: 'a@b.com', ssn: '123-45-6789' })
// 1. @ulid runs    (no-op here — id is t.id() not @ulid)
// 2. @cast.toDb    (no-op here)
// 3. @encrypt      ssn → Uint8Array (iv 12 || tag 16 || ct N)
// 4. SQL emitter sees the bytea — INSERT INTO "user" (..., "ssn") VALUES (..., $3)
```

Apps that combine `@encrypt` with `@cast` get the casted storage string before encryption — so a Money → string cast still works, and the cipher only ever sees the storage shape.

### Read path

```ts
const user = await userRepo.find('u-1')
// 1. Postgres returns ssn as a Buffer (bytea)
// 2. @encrypt decrypts → 'CASTED:123-45-6789' (or plain '123-45-6789')
// 3. @cast.fromDb runs on the decrypted string if declared
// 4. The hydrated Model has user.ssn === '123-45-6789' (plain string)
```

### Storage format + cipher

`AesGcm256Cipher` writes ciphertext as `iv (12 bytes) || tag (16 bytes) || ciphertext (N bytes)` — total overhead 28 bytes per encrypted field. The IV is freshly random per encrypt call (AES-GCM security requirement), so encrypting the same plaintext twice produces different ciphertexts. The 128-bit auth tag is checked on decrypt — any tampering throws.

### What's deferred

- **Key rotation.** V1 supports one key. Multi-key rings with a key-id header in the ciphertext envelope land later.
- **Searching encrypted columns.** Use a blind-index (HMAC-SHA-256 of the canonicalized plaintext) in a separate column if you need exact-match lookup. The framework doesn't ship one yet.
- **Per-tenant keys.** Same key for the whole app today.

### Inheritance + helpers

Same own-property reseed pattern as `@hidden` / `@cast` / `@ulid`. Subclasses inherit parent `@encrypt` fields; adding `@encrypt` on a subclass reseeds the Set so the parent's metadata stays untouched.

- `encryptedFieldsOf(ModelClass)` — `ReadonlySet<string>` of decorated field names.
- `applyEncryptToAttrs(ModelClass, attrs, cipher)` — encrypt the storage-shape attrs. Repository uses it internally.
- `applyDecryptToRow(ModelClass, row, cipher)` — decrypt a hydrated row. `hydrateRow` calls it when a cipher is supplied.
