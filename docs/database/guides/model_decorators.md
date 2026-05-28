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

## What's NOT here (yet)

Each lands as its own follow-up slice on this same metadata pattern:

- **`@cast`** — declarative field type coercion (e.g., `@cast('date')` for columns that come back as strings from some Postgres drivers).
- **`@encrypt`** — encryption-at-rest. Needs key config + a cipher provider; integrates with Repository's hydrate (decrypt on SELECT) and the SQL emitter (encrypt before INSERT/UPDATE).
- **`@ulid`** — per-field ULID auto-mint on the Model side (`emitInsert` already mints id-column ULIDs from the schema; this would be for non-PK columns).
