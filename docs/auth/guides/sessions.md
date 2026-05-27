# Sessions — `SessionGuard`, schema, migration

`SessionGuard` is the production replacement for `MemoryGuard`. State lives in a Postgres `session` table managed by `SessionRepository`; the client carries a ULID in a single cookie.

## Setup

### 1. Register the schema

`@strav/auth` ships `sessionSchema` — register it alongside your app schemas so the registry knows about it (the future migration generator needs this, and so do FK lookups).

```ts
// app/providers/schemas_provider.ts
import { SchemaRegistry } from '@strav/database'
import { sessionSchema } from '@strav/auth'
import { userSchema } from '../../database/schemas/user_schema.ts'

export class SchemasProvider extends ServiceProvider {
  override readonly name = 'schemas'
  override readonly dependencies = ['database']
  override boot(app: Application) {
    app.resolve(SchemaRegistry).registerAll([userSchema, sessionSchema])
  }
}
```

### 2. Write the migration

Use the DDL emitter — keeps the SQL in lock-step with the framework's schema:

```ts
// database/migrations/20260528120000_create_sessions.ts
import { emitCreateTable, emitDropTable, type Migration } from '@strav/database'
import { sessionSchema } from '@strav/auth'

export const migration: Migration = {
  name: '20260528120000_create_sessions',
  async up(db) {
    await db.execute(emitCreateTable(sessionSchema).sql)
    await db.execute(`CREATE INDEX idx_session_user_id ON "session" ("user_id")`)
    await db.execute(`CREATE INDEX idx_session_expires_at ON "session" ("expires_at")`)
  },
  async down(db) {
    await db.execute(emitDropTable(sessionSchema.name).sql)
  },
}
```

The two indexes aren't part of the Schema (indexes live with the migration builder DSL, which lands in a follow-up slice) — add them by hand. Both pay off: `user_id` for "kill all sessions for a user," `expires_at` for the cleanup query.

### 3. Configure the guard

```ts
// config/auth.ts
export default {
  default: 'web',
  guards: {
    web: {
      driver: 'session',
      userResolverService: 'UserRepository',  // any binding with `.find(id)`
      cookieName: 'app_session',                // default: 'strav_session'
      ttlSeconds: 60 * 60 * 24 * 14,            // default: 14 days
      secure: true,                              // default: true; flip for local HTTP dev
    },
  },
}
```

`userResolverService` points at any container binding with a `.find(id)` method. Every `@strav/database` Repository has one — bind your `UserRepository` under a known key in its provider:

```ts
app.singleton('UserRepository', (c) => c.resolve(UserRepository))
```

### 4. Wire the providers in order

```ts
app.useProviders([
  new ConfigProvider({ logger, database, auth }),
  new LoggerProvider(),
  new DatabaseProvider(),         // SessionRepository needs PostgresDatabase
  new HttpProvider(),
  new SchemasProvider(),           // register your schemas
  new UserRepositoryProvider(),    // bind your UserRepository under 'UserRepository'
  new AuthProvider(),              // resolves SessionGuard from config
])
```

The order matters: `AuthProvider` resolves the `SessionGuard` at `register()` time, which means `SessionRepository` (and transitively `PostgresDatabase`) must already be bindable.

## What `SessionGuard` does

```ts
class SessionGuard implements Guard {
  authenticate(ctx): User | null   // reads cookie → findValid → resolveUser
  login(ctx, user, opts?): void     // mints ULID + row, sets cookie
  logout(ctx): void                  // deletes row, clears cookie
}
```

- **`authenticate`**: reads the cookie, calls `SessionRepository.findValid(id)` (one round-trip that checks `expires_at > now()`), then hands the `user_id` to `userResolver`. Missing cookie / expired session / deleted user → `null`.
- **`login`**: mints a fresh ULID, creates a session row with `expires_at = now + ttl`, sets the cookie. The cookie carries `expires` matching `expires_at` so it disappears from the client when the session ends server-side.
- **`logout`**: looks up the cookie's session row (if any), deletes it, clears the cookie. No-op on the row when the cookie is missing or the row is already gone — the cookie still gets cleared.

## Cookie defaults

| Attribute | Default | Why |
|---|---|---|
| `httpOnly` | `true` | XSS can't steal the cookie. |
| `sameSite` | `'lax'` | CSRF protection without breaking top-level navigations. |
| `secure` | `true` | HTTPS-only. Flip to `false` for `http://localhost` dev. |
| `path` | `'/'` | Visible to the whole app. |
| `expires` | `now + ttl` | Client-side cleanup matches server-side TTL. |

## What's NOT here

Each lands as its own slice on top of this foundation:

- **Sliding-window expiry.** `expires_at` is set at login and never bumped. Apps that want active users to stay signed in past `ttl` minutes-since-login (typical web auth) will get a `touch()` enrichment that runs after authenticate.
- **Session-fixation prevention.** Standard practice is to rotate the session id on login (after credential verification). A `regenerate()` helper lands separately — call it from your login route once it ships.
- **Session payload.** Flash messages, CSRF tokens, locale, "remember me" markers all want a `jsonb` payload column. Schema gets `t.json('payload')`; SessionGuard gets `get(key)` / `put(key, value)` accessors.
- **`sessions:gc` console command.** `SessionRepository.deleteExpired(now)` is already implemented; the CLI command that calls it on a cron lands with `@strav/cli`.
- **`SessionGuard.killAllForUser(id)`.** Useful for "log me out everywhere." Trivial to implement, lands when the use case shows up.

## Migrating from `MemoryGuard`

`SessionGuard` and `MemoryGuard` implement the same `Guard` interface, so handlers and middleware don't change. Two config edits:

```diff
-app.singleton('memory_guard', () => new MemoryGuard({ name: 'memory', userResolver: byId }))
```

```diff
 // config/auth.ts
 export default {
-  default: 'memory',
+  default: 'web',
   guards: {
-    memory: { driver: 'custom', service: 'memory_guard' },
+    web: { driver: 'session', userResolverService: 'UserRepository' },
   },
 }
```

Add `DatabaseProvider` to your provider list (if you weren't using it yet) and ship the `create_sessions` migration. `MemoryGuard` stays useful for fast unit tests where spinning up Postgres is overkill.

## Production checklist

- [ ] `secure: true` in production config.
- [ ] HTTPS termination in front of the app — `secure` cookies don't get sent over plain HTTP.
- [ ] `idx_session_user_id` + `idx_session_expires_at` indexes from the migration above.
- [ ] A scheduled job calling `sessionRepo.deleteExpired()` (cron, queue job, etc.) — until the `sessions:gc` command lands.
- [ ] User-facing "log out" route calls `ctx.auth.logout()`.
