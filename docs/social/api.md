# @strav/social — API reference

## Top-level surface (`@strav/social`)

### `SocialManager`

```ts
class SocialManager {
  readonly config: SocialConfig

  use(name?: string): SocialDriver
  extend(driverName: string, factory: SocialDriverFactory): void
  useDriver(instanceName: string, driver: SocialDriver): void

  // Default-driver resource accessors
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>
  exchange(input: ExchangeInput): Promise<OAuthTokens>
  profile(accessToken: string): Promise<SocialProfile>
  refresh(input: RefreshInput): Promise<OAuthTokens>
  revoke(token: string): Promise<void>
}
```

### `SocialProvider`

`ServiceProvider`. Wires `SocialManager` from `config.social`. Depends on `config`. Eager-resolves at boot so config errors surface early.

### `SocialDriver` (driver contract)

```ts
interface SocialDriver {
  readonly name: string
  readonly instanceName: string
  readonly capabilities: ReadonlySet<SocialCapability>
  readonly availableScopes: readonly string[]

  authorize(input: AuthorizeInput): Promise<AuthorizeResult>
  exchange(input: ExchangeInput): Promise<OAuthTokens>
  profile(accessToken: string): Promise<SocialProfile>
  refresh(input: RefreshInput): Promise<OAuthTokens>
  revoke(token: string): Promise<void>
}
```

### `SocialCapability`

String-literal union. See `payment_capabilities.ts` for the full list:

```
openid, pkce.support, pkce.required,
profile.id, profile.email, profile.emailVerified, profile.name, profile.avatar, profile.locale,
tokens.exchange, tokens.refresh, tokens.revoke, tokens.introspect,
scopes.discoverable
```

### DTOs

```ts
interface SocialProfile {
  id: string                       // provider-native subject id
  provider: string
  email?: string
  emailVerified?: boolean
  name?: string
  avatarUrl?: string
  locale?: string
  metadata: Record<string, unknown>
  raw: unknown
}

interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string                 // OIDC providers only
  expiresAt?: Date
  scope?: string
  tokenType: string
  raw: unknown
}
```

### Input types

```ts
interface AuthorizeInput {
  redirectUri: string
  scopes?: readonly string[]
  state?: string                   // omit → driver generates
  codeVerifier?: string            // omit → driver generates (if PKCE)
  extra?: Record<string, string>   // provider-specific params
}

interface AuthorizeResult {
  url: string
  state: string
  codeVerifier?: string            // set when driver used PKCE
}

interface ExchangeInput {
  code: string
  redirectUri: string
  state?: string
  expectedState?: string           // verify against state
  codeVerifier?: string            // required when PKCE was used
}

interface RefreshInput {
  refreshToken: string
  scopes?: readonly string[]
}
```

### PKCE + state helpers

```ts
randomCodeVerifier(): string                    // 64 chars, ~384 bits entropy
codeChallengeFor(verifier: string): Promise<string>   // base64url SHA-256
randomState(): string                           // 32 bytes base64url
```

### Errors

```
SocialError (extends StravError)
├── SocialConfigError              (500 — boot)
├── UnknownProviderError           (400 — config lookup miss)
├── ProviderUnsupportedError       (400 — driver lacks operation)
├── StateMismatchError             (400 — CSRF / misrouted)
├── OAuthExchangeError             (400 — provider rejected code)
├── InvalidTokenError              (401 — expired / revoked)
└── SocialProviderError            (502 — vendor exception wrapper)
```

### Ledger (account linking)

```ts
applySocialAccountMigration(db, { registry }): Promise<void>

class SocialAccount extends Model { … }       // typed row; tokens decrypted via @encrypt

class SocialAccountRepository {
  connect(input: ConnectInput): Promise<SocialAccount>
  disconnect(input: DisconnectInput): Promise<void>
  findByUser(userId: string): Promise<SocialAccount[]>
  findByUserAndProvider(userId: string, provider: string): Promise<SocialAccount | null>
  findByProviderIdentity(provider: string, providerUserId: string): Promise<SocialAccount | null>
}

interface ConnectInput {
  userId: string
  provider: string
  profile: SocialProfile
  tokens: OAuthTokens
}

interface DisconnectInput {
  userId: string
  provider: string
}

class SocialAccountAlreadyLinkedError extends Error {
  readonly provider: string
  readonly providerUserId: string
  readonly existingUserId: string
  readonly attemptedUserId: string
}
```

### Mock driver

`MockDriver` — in-memory reference implementation with full capability set. PKCE + state are enforced (verifier mismatch throws); refresh rotates tokens; revoke invalidates. Apps testing capability-gated UI use this against a narrowed `capabilities` set.

```ts
new MockDriver({
  instanceName?: string
  capabilities?: ReadonlySet<SocialCapability>
  profileFor?(accessToken: string): SocialProfile
})
```

## `@strav/social/line`

| Export | Notes |
|---|---|
| `LineSocialProvider` | ServiceProvider — registers `driver: 'line'`. |
| `LineSocialDriver` | Direct driver instance (for tests + `useDriver()`). |
| `LineProviderConfig` | `{ driver: 'line', clientId, clientSecret, uiLocales?, endpoints?, fetch? }`. |
| `LINE_ENDPOINTS` | Default Line endpoint URLs (overridable in config for tests). |
| `emailFromLineIdToken(idToken)` | JWT payload decode helper — Line omits email from `/v2/profile`. |

Capabilities: `openid`, `pkce.support`, `profile.{id,email,emailVerified,name,avatar}`, `tokens.{exchange,refresh,revoke,introspect}`, `scopes.discoverable`. **No `profile.locale`**.

## `@strav/social/google`

| Export | Notes |
|---|---|
| `GoogleSocialProvider` | ServiceProvider — `driver: 'google'`. |
| `GoogleSocialDriver` | Direct driver. |
| `GoogleProviderConfig` | `{ driver: 'google', clientId, clientSecret, offlineAccess?, endpoints?, fetch? }`. |
| `GOOGLE_ENDPOINTS` | Default URLs. |
| `emailFromGoogleIdToken(idToken)` | JWT decode helper (userinfo also has `email`). |

Full capability set including `profile.locale`. `refresh()` preserves caller's refresh token (Google does not rotate).

## `@strav/social/facebook`

| Export | Notes |
|---|---|
| `FacebookSocialProvider` | ServiceProvider — `driver: 'facebook'`. |
| `FacebookSocialDriver` | Direct driver. `.exchangeForLongLivedToken(accessToken)` swaps short-lived for ~60-day token. `.debugToken(token)` calls Graph `/debug_token`. |
| `FacebookProviderConfig` | `{ driver: 'facebook', clientId, clientSecret, graphVersion?, profileFields?, endpoints?, fetch? }`. |
| `facebookEndpoints(version)` | Endpoint builder. |
| `DEFAULT_FACEBOOK_PROFILE_FIELDS` | Default `fields=` list for `/me`. |

Plain OAuth2 (no `openid`). `refresh()` **throws** `ProviderUnsupportedError` — Facebook doesn't issue refresh tokens; use `exchangeForLongLivedToken`. No `profile.emailVerified`.

## `@strav/social/tenanted`

Opt-in tenanted variant — same surface as the default ledger, scoped per tenant via RLS. See [guides/multi-tenancy.md](./guides/multi-tenancy.md).

| Export | Notes |
|---|---|
| `applyTenantedSocialAccountMigration` | Tenant-scoped DDL. |
| `TenantedSocialAccount` | Tenanted Model. |
| `TenantedSocialAccountRepository` | Same surface as `SocialAccountRepository`. Callers must wrap in `TenantManager.withTenant(...)`. |
| `tenantedSocialAccountSchema` | Tenanted schema. |
