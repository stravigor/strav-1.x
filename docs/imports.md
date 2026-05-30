# Where to import what

Cross-package symbol matrix. Apps assembling Strav often need to remember which package owns which symbol — the splits are intentional but cumulative. This page is the cheat sheet.

| Symbol | Import from | Purpose |
|---|---|---|
| **Container + lifecycle** | | |
| `Application` | `@strav/kernel` | The root container; `app.useProviders(...)` + `app.start()`. |
| `ServiceProvider` | `@strav/kernel` | Base class for all `<X>Provider` classes. |
| `ConfigProvider`, `ConfigRepository` | `@strav/kernel` | Boot-time config. |
| `LoggerProvider`, `Logger`, `LogChannel` | `@strav/kernel` | Logging. |
| `EventBus` | `@strav/kernel` | In-process event bus; Repository constructor takes it. |
| `inject`, `singleton`, `bind` | `@strav/kernel` | DI primitives. |
| **Errors** | | |
| `StravError` | `@strav/kernel` | Base error class every package's `<X>Error` extends. |
| `ConfigError` | `@strav/kernel` | Thrown by `ConfigProvider` when required keys missing. |
| **Crypto + encryption** | | |
| `Cipher`, `EncryptionProvider`, `parseEncryptionKey` | `@strav/kernel` | The cipher primitives. |
| `@encrypt` (decorator) | `@strav/database` | Decorate Model properties for at-rest encryption — `@encrypt access_token!: string`. |
| `t.encrypted('col')` | `@strav/database` (schema builder) | Schema-side column type matching `@encrypt`. |
| **Database** | | |
| `PostgresDatabase`, `DatabaseProvider`, `DatabaseExecutor` | `@strav/database` | Postgres connection + provider. |
| `Repository`, `Model`, `Schema` | `@strav/database` | ORM primitives. |
| `defineSchema`, `Archetype`, `SchemaRegistry`, `emitCreateTable` | `@strav/database` | Schema definition + DDL emission. |
| `quoteIdent` | `@strav/database` | Safe identifier quoting for hand-written SQL. |
| **Multi-tenancy** | | |
| `TenantManager` | `@strav/database` | The session-scoping helper. Apps wrap calls in `tenants.withTenant(id, fn)`. |
| `tenantedMetadata`, `readTenantId`, `TENANT_METADATA_KEY` | `@strav/payment` | Stamp the framework's tenant key on provider-side metadata so webhook events carry tenant identity. |
| **HTTP** | | |
| `HttpKernel`, `HttpProvider`, `HttpContext` | `@strav/http` | Bun-backed HTTP server. |
| `Router`, `MiddlewareRegistry` | `@strav/http` | Routing + middleware composition. |
| **Auth** | | |
| `AuthProvider`, `User`, `Session`, `AccessToken` | `@strav/auth` | The user/session/token primitives. |
| `Gate`, `Policy` | `@strav/auth` | Authorisation primitives. |
| `MagicLink`, `TotpManager` | `@strav/auth` | Magic-link + TOTP (M3.5 auth-extras). |
| **Queue + signal + view** | | |
| `Queue`, `Job`, `Worker`, `DatabaseQueue`, `SyncQueue` | `@strav/queue` | Job dispatch. |
| `Signal`, `signalEmail`, transactional mail | `@strav/signal` | Mail / transactional notifications. Composes with `@strav/view`. |
| `View`, `template`, `render` | `@strav/view` | Template rendering. |
| **Brain (LLM)** | | |
| `BrainManager`, `BrainProvider`, `Agent`, `BrainError` | `@strav/brain` | LLM abstraction. |
| `AnthropicProvider`, `OpenAIProvider`, `OpenAIResponsesProvider`, `GeminiProvider` | `@strav/brain` | Driver implementations (note: `Provider` suffix is historical — these are drivers, not ServiceProviders; rename pending). |
| Persistence (threads / messages / runs) | `@strav/brain/persistence` | Subpath. |
| MCP client | `@strav/brain/mcp` | Subpath. |
| Zod schema helpers for structured output | `@strav/brain/zod` | Subpath. |
| **RAG** | | |
| `RagManager`, `RagProvider`, `applyRagVectorMigration`, `ragVectorSchema` | `@strav/rag` | Vector store abstraction. |
| `retrievable()` mixin | `@strav/rag` | Repository mixin for `Article.vectorize() / .retrieve()`. |
| **Payment** | | |
| `PaymentManager`, `PaymentProvider`, `PaymentError` | `@strav/payment` | Provider-agnostic payment abstraction. |
| `applyPaymentLedgerMigration`, `paymentCustomerSchema`, … | `@strav/payment` | Ledger primitives. |
| `tenantedMetadata`, `readTenantId` | `@strav/payment` | Tenant-on-webhook routing (see Multi-tenancy row above). |
| `StripePaymentDriver`, `StripePaymentProvider` | `@strav/payment/stripe` | Stripe adapter. |
| `OmisePaymentDriver`, `OmisePaymentProvider`, `omisePriceSpec` | `@strav/payment/omise` | Omise adapter. |
| **Social** | | |
| `SocialManager`, `SocialProvider`, `SocialError`, capabilities | `@strav/social` | Provider-agnostic OAuth/OIDC. |
| `applySocialAccountMigration`, `SocialAccountRepository`, `SocialAccount` | `@strav/social` | Account-linking ledger (non-tenanted default). |
| `LineSocialDriver`, `LineSocialProvider`, `emailFromLineIdToken` | `@strav/social/line` | Line Login v2.1. |
| `GoogleSocialDriver`, `GoogleSocialProvider`, `emailFromGoogleIdToken` | `@strav/social/google` | Google Sign-In. |
| `FacebookSocialDriver`, `FacebookSocialProvider` | `@strav/social/facebook` | Facebook Login. |
| `applyTenantedSocialAccountMigration`, `TenantedSocialAccountRepository` | `@strav/social/tenanted` | Opt-in tenanted variant. |

## Why some splits look surprising

- **`@encrypt` (database) vs `Cipher` (kernel)** — the decorator decorates ORM properties, so it ships with the ORM. The cipher is general crypto, so it ships with kernel. Apps that use the ORM-level encryption must register `EncryptionProvider` (kernel) so the Repository can resolve the `Cipher`.
- **`tenantedMetadata` lives in `@strav/payment` even though tenants live in `@strav/database`** — the helper is specifically about stamping tenant id on payment-provider metadata so it round-trips through webhook events. `@strav/database` doesn't know about provider metadata; payment does.
- **Brain providers don't live on subpaths** — unlike `@strav/payment/stripe` or `@strav/social/line`, brain bundles all drivers in the top-level package. Historical; a rename + subpath split is a [Proposed action item](./code-quality.md#5-action-items--prioritized) (#2).

## Adding to this matrix

When adding a new package or a cross-package symbol, append a row in the relevant section. Keep symbols in import-order (kernel → database → http → auth → … → brain → rag → payment → social). When a symbol moves between packages (rare but possible), update both rows.
