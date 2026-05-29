# Magic Links

Single-use, short-lived URLs for passwordless sign-in. The user submits their email, gets a link, clicks it, and the controller logs them in via the configured guard. The security boundary is **email delivery + single-use + short TTL** — not token secrecy.

## When to use

- Passwordless sign-in / "magic link" auth flows.
- "Forgot password" reset links (model the same way — `redirectTo` points at the password form).
- Out-of-band confirmation flows where you want to *authenticate* the user, not just confirm an email. (Use `EmailVerification` for the latter — see [`verification.md`](./verification.md).)

## What's in the package

- `MagicLinkManager` — `create(userId, opts?)` and `consume(token)`.
- `magicLinkSchema` — the `strav_magic_links` schema you migrate into your DB.
- `MagicLinkError` — typed error (`code: 'auth.magic-link-error'`, status 400). Carries `context.code` of `'invalid' | 'used' | 'expired'`.

`AuthProvider` registers `MagicLinkManager` as a container singleton when `config.auth.magic.baseUrl` (or `config.app.url`) is set.

## Setup

### 1. Migrate the table

```ts
// app/database/schemas.ts
import { magicLinkSchema } from '@strav/auth'
schemaRegistry.register(magicLinkSchema)
```

Then `bun strav db:migrate` (the CLI's `migrate` slice picks it up).

### 2. Configure base URL

```ts
// config/auth.ts
export default {
  default: 'session',
  guards: { /* … */ },
  magic: { baseUrl: process.env.APP_URL, path: '/auth/magic' },  // path is optional, default '/auth/magic'
}
```

Or skip `auth.magic` entirely — the provider falls back to `config.app.url`.

### 3. Wire the controller

```ts
// app/http/controllers/magic_link_controller.ts
import type { HttpContext } from '@strav/http'
import { MagicLinkManager } from '@strav/auth'

export class MagicLinkController {
  static providers = [MagicLinkManager]
  constructor(private readonly links: MagicLinkManager) {}

  // POST /auth/magic — user submits their email
  async request(ctx: HttpContext) {
    const { email } = await ctx.request.body<{ email: string }>()
    const user = await userRepository.byEmail(email)
    if (!user) return ctx.response.ok({ sent: true })  // don't leak existence

    const url = await this.links.create(user.id, { ttl: '15m', redirectTo: '/dashboard' })
    await SendMagicLinkEmail.dispatch({ email, url })  // @strav/signal + @strav/queue
    return ctx.response.ok({ sent: true })
  }

  // GET /auth/magic/:token — user clicks the email link
  async consume(ctx: HttpContext) {
    try {
      const { userId, redirectTo } = await this.links.consume(ctx.request.params.token)
      const user = await userRepository.byId(userId)
      if (!user) return ctx.response.unauthorized()
      await ctx.auth!.login(user)
      return ctx.response.redirect(redirectTo ?? '/')
    } catch (err) {
      // MagicLinkError → render a "this link is stale" page
      throw err
    }
  }
}
```

### 4. Register routes

```ts
router.post('/auth/magic',         [MagicLinkController, 'request'])
router.get ('/auth/magic/:token',  [MagicLinkController, 'consume'])
```

## TTL formats

`create(userId, { ttl })` accepts:

| Form | Meaning |
|---|---|
| `'30s'` | seconds |
| `'15m'` | minutes (default) |
| `'1h'` | hours |
| `'7d'` | days |
| `900` | bare number → seconds |

Invalid formats throw `MagicLinkError` at create time.

## Error semantics

`consume(token)` throws `MagicLinkError` with `context.code`:

| Code | Meaning | Suggested UX |
|---|---|---|
| `'invalid'` | Token not in DB | "This link is no longer valid." |
| `'used'` | `used_at != null` | "This link has already been used. Request a new one." |
| `'expired'` | `expires_at < now` | "This link has expired. Request a new one." |

All three are status 400.

## Schema

```sql
CREATE TABLE "strav_magic_links" (
  id           VARCHAR(26) PRIMARY KEY,    -- ULID
  user_id      VARCHAR(26) NOT NULL,        -- FK to your users table
  token        VARCHAR(64) NOT NULL UNIQUE, -- 32 random bytes hex
  redirect_to  VARCHAR(2048),
  expires_at   TIMESTAMP NOT NULL,
  used_at      TIMESTAMP,
  created_at   TIMESTAMP NOT NULL,
  updated_at   TIMESTAMP NOT NULL
);
```

The `Archetype.Event` archetype gives you the timestamp columns + sensible defaults. The `token UNIQUE` index is what `consume` looks up against — a PK-class lookup, not a scan.

## Pruning

Consumed rows are kept for audit. Add a scheduled job to delete old rows:

```ts
// app/console/commands/magic_prune.ts
scheduler.command('magic:prune').dailyAt('03:00')

// implementation
await db.execute(
  `DELETE FROM "strav_magic_links" WHERE expires_at < now() - interval '30 days'`,
)
```

## Production checklist

- [ ] Migrate `strav_magic_links`.
- [ ] Set `config.app.url` (or `config.auth.magic.baseUrl`) to the public URL.
- [ ] Route `POST /auth/magic` is rate-limited (per-IP + per-email).
- [ ] Don't reveal whether an email exists in your DB on the request step (always return success).
- [ ] Schedule `magic:prune` (or equivalent) to cap table growth.
- [ ] Email job uses `@strav/queue` so a failed SMTP send retries instead of dropping the user mid-flow.
