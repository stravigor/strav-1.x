# Tokens — `TokenGuard`, `AccessToken` schema, minting, revocation

`TokenGuard` is bearer-token authentication backed by an `access_token` table. Tokens carry a row id + a secret half; the row stores the SHA-256 of the secret. Verification is a PK lookup + constant-time hash compare — fast, scan-free, and the same pattern Laravel Sanctum / GitHub PATs / Stripe API keys use.

## Setup

### 1. Register the schema

```ts
// app/providers/schemas_provider.ts
import { SchemaRegistry } from '@strav/database'
import { accessTokenSchema, sessionSchema } from '@strav/auth'
import { userSchema } from '../../database/schemas/user_schema.ts'

export class SchemasProvider extends ServiceProvider {
  override readonly name = 'schemas'
  override readonly dependencies = ['database']
  override boot(app: Application) {
    app.resolve(SchemaRegistry).registerAll([userSchema, sessionSchema, accessTokenSchema])
  }
}
```

### 2. Write the migration

```ts
// database/migrations/20260528130000_create_access_tokens.ts
import { emitCreateTable, emitDropTable, type Migration } from '@strav/database'
import { accessTokenSchema } from '@strav/auth'

export const migration: Migration = {
  name: '20260528130000_create_access_tokens',
  async up(db) {
    await db.execute(emitCreateTable(accessTokenSchema).sql)
    await db.execute(`CREATE INDEX idx_access_token_user_id ON "access_token" ("user_id")`)
    await db.execute(`CREATE INDEX idx_access_token_expires_at ON "access_token" ("expires_at")`)
  },
  async down(db) {
    await db.execute(emitDropTable(accessTokenSchema.name).sql)
  },
}
```

The `idx_access_token_user_id` index pays off `revokeAllForUser` and "list this user's tokens" queries; `idx_access_token_expires_at` pays off the cleanup query when the `tokens:gc` command lands.

### 3. Configure the guard

```ts
// config/auth.ts
export default {
  default: 'web',                               // probably your session guard
  guards: {
    web: { driver: 'session', userResolverService: 'UserRepository' },
    api: {
      driver: 'token',
      userResolverService: 'UserRepository',
      // headerName: 'authorization',           // default
      // scheme: 'Bearer',                       // default; case-insensitive
    },
  },
}
```

Use `ctx.auth.guard('api')` in API routes that should accept tokens but not session cookies. Use `ctx.auth.guard('web')` (or just `ctx.auth`) in browser routes. Both can coexist.

## Minting a token

Tokens are minted out-of-band — typically from a "create API token" endpoint on the user's settings page. `createToken` returns the plaintext **once**:

```ts
import { AccessTokenRepository } from '@strav/auth'

class TokensController {
  constructor(private tokens: AccessTokenRepository) {}

  async create(ctx: HttpContext) {
    const auth = assertAuth(ctx)
    const user = await auth.userOrFail()
    const { plaintext, model } = await this.tokens.createToken(
      user.getAuthIdentifier(),
      ctx.request.input('name'),
      { expiresInSeconds: 60 * 60 * 24 * 90 },   // 90 days; omit for never-expires
    )
    return ctx.response.ok({
      id: model.id,
      name: model.name,
      expires_at: model.expires_at,
      token: plaintext,                            // SHOW ONCE
    })
  }
}
```

The plaintext is the *only* time the full token is recoverable. Persist the user-facing display in the response, then forget it server-side. The framework never stores the plaintext.

## Using a token

Clients send the plaintext via the configured header:

```bash
curl -H 'Authorization: Bearer 01HZE2…|abcDEF…' https://api.example.com/me
```

The TokenGuard parses `id|secret`, PK-looks-up the row, constant-time-compares the secret hash, checks `expires_at`, hands the `user_id` to the resolver. Successful auth populates `ctx.auth.user`.

## Revoking tokens

Three flavors:

```ts
// 1. Revoke the current request's token.
await ctx.auth.guard('api').logout(ctx)

// 2. Revoke a specific token by id (typically called from a user-settings endpoint).
const token = await tokens.findOrFail(tokenId)
await tokens.delete(token)

// 3. Nuclear — every token for this user (password change, account compromise).
await tokens.revokeAllForUser(userId)
```

`revokeAllForUser` returns the affected count.

## What's NOT here

Each lands as its own slice on top of this foundation:

- **Abilities / scopes.** Tokens today grant full access — there's no `abilities: ['read', 'write']` column. Lands with the auth policies slice. When it lands, schema gets `t.json('abilities').nullable()`, the guard checks them, and middleware like `'auth:api|ability:read'` becomes possible.
- **`last_used_at` updates.** Useful for audit + "kill unused tokens" cleanup. Writing on every authenticate is prohibitively expensive without batching; lands with a write-batching enrichment.
- **`ctx.token` cache.** The authenticated AccessToken row isn't exposed to handlers today. Lands when a use case shows up ("list this token's abilities," "show token name on /me").
- **`tokens:gc` console command.** Bulk-cleanup of expired rows. The `AccessTokenRepository` already supports the operation via a `query().where('expires_at', '<', now).get()` + delete loop; the CLI wrapper lands with `@strav/cli`.
- **Token prefixes.** Stripe-style `stv_live_…` / `stv_test_…` prefixes are nice for log-redaction and environment safety. Lands as a `prefix` option on `createToken` + a prefix-aware redactor when there's demand.

## Production checklist

- [ ] Schema registered + migration applied; both indexes present.
- [ ] `createToken` shown to user *once* and not persisted server-side.
- [ ] Token-creation endpoint behind the `auth` middleware (sessions, not tokens — bootstrapping problem).
- [ ] Token-revocation endpoint behind `auth:api` (a token can revoke itself).
- [ ] Password-change flow calls `revokeAllForUser(id)` to invalidate stolen tokens.
- [ ] A scheduled job clears expired rows (until the `tokens:gc` command lands).
- [ ] HTTPS termination — bearer tokens over plain HTTP get sniffed.
