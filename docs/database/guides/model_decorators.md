# Model decorators

Model decorators change in-memory shape or serialization without altering the underlying schema or DDL. V1 ships `@hidden`; the rest of the serialization slice (`@cast`, `@encrypt`, `@ulid`) lands incrementally on the same metadata pattern.

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

## What's NOT here (yet)

Each lands as its own follow-up slice on this same metadata pattern:

- **`@encrypt`** — encryption-at-rest. Needs key config + a cipher provider; integrates with Repository's hydrate (decrypt on SELECT) and the SQL emitter (encrypt before INSERT/UPDATE). The schema's `t.encrypted()` field kind already maps to `bytea` storage; `@encrypt` is the runtime cipher piece.
- **`@ulid`** — per-field ULID auto-mint on the Model side (`emitInsert` already mints id-column ULIDs from the schema; this would be for non-PK columns).
