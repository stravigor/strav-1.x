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

## Session lifecycle helpers

Three small helpers cover the session-management patterns every production app needs.

### `regenerate(ctx)` — session-fixation prevention

Call right after credential verification in a login route. Mints a fresh session id (so the pre-authenticated cookie value can't be hijacked), copies the existing `user_id` + `payload` across, deletes the old row, sets the new cookie.

```ts
async login(ctx: HttpContext) {
  const user = await this.authenticate(ctx.request.input('email'), ctx.request.input('password'))
  if (!user) return ctx.response.unauthorized()
  await ctx.auth.guard().login(ctx, user)
  await ctx.auth.guard().regenerate(ctx)     // ← rotate the id after the credential check
  return ctx.response.redirect('/dashboard')
}
```

Returns the new `Session` or `null` if no valid session was bound (e.g., the user has no cookie yet — call `login(ctx, user)` instead).

### `touch(ctx)` — sliding-window expiry

By default, `expires_at` is set once at `login` and never bumped — a 14-day token starts the clock at login and dies 14 days later regardless of activity. `touch(ctx)` bumps `expires_at` to `now + ttlSeconds` so active users stay signed in. Call from an "active user" middleware after auth:

```ts
// app/middleware/touch_session.ts
export const touchSession: HttpMiddleware = async (ctx, next) => {
  await ctx.auth.guard().touch(ctx)
  return next()
}
```

Returns the updated `Session` or `null` if there's no valid session bound. The cookie's `expires` attribute is bumped too so the client's view matches.

### `killAllForUser(userId)` — bulk revoke

For password-change flows and "log out everywhere" buttons. Wipes every session row for the user. The current request's cookie is NOT touched — apps that need to log the current user out call `logout(ctx)` separately.

```ts
async changePassword(ctx: HttpContext) {
  const user = await ctx.auth.userOrFail()
  await this.users.updatePassword(user.id, ctx.request.input('new_password'))
  await ctx.auth.guard().killAllForUser(user.id)   // invalidate every other session
  await ctx.auth.guard().logout(ctx)                // and the current one
  return ctx.response.redirect('/login?reason=password-changed')
}
```

Returns the affected row count.

## What's NOT here

Each lands as its own slice on top of this foundation:

- **Auto-flush middleware** that calls `patchPayload` automatically when handlers mutate the session payload. Today, payload writes are explicit (apps call `sessions.patchPayload(s, { … })`).
- **`sessions:gc` console command.** `SessionRepository.deleteExpired(now)` is already implemented; the CLI command that calls it on a cron lands with `@strav/cli`.

## Payload column — flash messages, CSRF tokens, locale

The session schema includes a nullable `payload jsonb` column for request-scoped state. Apps patch it through `SessionRepository.patchPayload(session, partial)`:

```ts
// Set a flash message before redirecting.
await sessions.patchPayload(session, { 'flash.success': 'Saved!' })

// Read it on the next request.
const flash = (session.payload as Record<string, unknown> | null)?.['flash.success']

// Clear after rendering.
await sessions.patchPayload(session, { 'flash.success': null })
```

`patchPayload`:

1. Shallow-merges `partial` into `session.payload ?? {}` (null payload treated as empty).
2. Routes through `Repository.update(...)` — `updated_at` auto-bumps, `session.updating` + `session.updated` events fire normally, the post-write row hydrates back via `RETURNING *`.
3. Returns the updated `Session`.

The merge is intentionally **shallow** — `patchPayload(s, { foo: { bar: 1 } })` replaces any existing `foo` wholesale. Apps that need deep semantics spread the existing payload themselves:

```ts
await sessions.patchPayload(session, {
  preferences: { ...(session.payload?.['preferences'] as object ?? {}), theme: 'dark' },
})
```

### Migrating an existing `session` table

Fresh apps using `emitCreateTable(sessionSchema)` get the `payload` column automatically. If your app shipped the session table before this slice, add the column with a follow-up migration:

```ts
// database/migrations/20260530000000_add_session_payload.ts
import { emitAddColumn, emitDropColumn, type Migration } from '@strav/database'
import { sessionSchema } from '@strav/auth'

export const migration: Migration = {
  name: '20260530000000_add_session_payload',
  async up(db) {
    await db.execute(emitAddColumn(sessionSchema, 'payload').sql)
  },
  async down(db) {
    await db.execute(emitDropColumn(sessionSchema.name, 'payload').sql)
  },
}
```

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
