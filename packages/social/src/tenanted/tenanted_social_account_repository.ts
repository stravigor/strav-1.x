/**
 * `TenantedSocialAccountRepository` — same surface as
 * `SocialAccountRepository`, scoped to the tenanted schema.
 * Callers MUST be inside a `TenantManager.withTenant(...)`
 * scope; the INSERT relies on the session's `app.tenant_id`
 * setting (RLS).
 *
 * The implementation deliberately mirrors the non-tenanted
 * Repository line-for-line — minor code duplication is worth
 * it to keep both variants narrowly scoped + avoid runtime
 * branching on a tenancy flag.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase value import for @inject() metadata.
import { PostgresDatabase, quoteIdent, Repository, SchemaRegistry } from '@strav/database'
// biome-ignore lint/style/useImportType: Cipher + EventBus value imports for @inject() metadata.
import { Cipher, EventBus, inject, ulid } from '@strav/kernel'
import type { OAuthTokens, SocialProfile } from '../dto/index.ts'
import { SocialAccountAlreadyLinkedError } from '../ledger/social_account_repository.ts'
import { TenantedSocialAccount } from './tenanted_social_account.ts'
import { tenantedSocialAccountSchema } from './tenanted_social_account_schema.ts'

export interface ConnectInput {
  userId: string
  provider: string
  profile: SocialProfile
  tokens: OAuthTokens
}

export interface DisconnectInput {
  userId: string
  provider: string
}

@inject()
export class TenantedSocialAccountRepository extends Repository<TenantedSocialAccount> {
  static override readonly schema = tenantedSocialAccountSchema
  static override readonly model = TenantedSocialAccount

  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor forces TS to emit `design:paramtypes` for @inject(). The fourth param is the Cipher for @encrypt token columns.
  constructor(
    db: PostgresDatabase,
    events: EventBus,
    registry?: SchemaRegistry,
    cipher?: Cipher,
  ) {
    super(db, events, registry, cipher)
  }

  async connect(input: ConnectInput): Promise<TenantedSocialAccount> {
    const existing = await this.findByProviderIdentity(
      input.provider,
      input.profile.id,
    )
    const now = new Date()

    if (existing) {
      if (existing.user_id !== input.userId) {
        throw new SocialAccountAlreadyLinkedError({
          provider: input.provider,
          providerUserId: input.profile.id,
          existingUserId: existing.user_id,
          attemptedUserId: input.userId,
        })
      }
      return this.update(existing, {
        email: input.profile.email ?? null,
        name: input.profile.name ?? null,
        avatar_url: input.profile.avatarUrl ?? null,
        locale: input.profile.locale ?? null,
        access_token: input.tokens.accessToken,
        refresh_token: input.tokens.refreshToken ?? null,
        id_token: input.tokens.idToken ?? null,
        expires_at: input.tokens.expiresAt ?? null,
        scope: input.tokens.scope ?? null,
        updated_at: now,
      } as Partial<TenantedSocialAccount>)
    }

    return this.create({
      id: ulid(),
      user_id: input.userId,
      provider: input.provider,
      provider_user_id: input.profile.id,
      email: input.profile.email ?? null,
      name: input.profile.name ?? null,
      avatar_url: input.profile.avatarUrl ?? null,
      locale: input.profile.locale ?? null,
      access_token: input.tokens.accessToken,
      refresh_token: input.tokens.refreshToken ?? null,
      id_token: input.tokens.idToken ?? null,
      expires_at: input.tokens.expiresAt ?? null,
      scope: input.tokens.scope ?? null,
      metadata: {},
      created_at: now,
      updated_at: now,
    } as Partial<TenantedSocialAccount>)
  }

  async disconnect(input: DisconnectInput): Promise<void> {
    const table = quoteIdent(tenantedSocialAccountSchema.name)
    await this.db.execute(
      `DELETE FROM ${table} WHERE "user_id" = $1 AND "provider" = $2`,
      [input.userId, input.provider],
    )
  }

  async findByUser(userId: string): Promise<TenantedSocialAccount[]> {
    const table = quoteIdent(tenantedSocialAccountSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE "user_id" = $1 ORDER BY "created_at"`,
      [userId],
    )
    return Promise.all(rows.map((r) => this.hydrate(r)))
  }

  async findByUserAndProvider(
    userId: string,
    provider: string,
  ): Promise<TenantedSocialAccount | null> {
    const table = quoteIdent(tenantedSocialAccountSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE "user_id" = $1 AND "provider" = $2 LIMIT 1`,
      [userId, provider],
    )
    if (rows.length === 0) return null
    return this.hydrate(rows[0]!)
  }

  /**
   * Sign-in lookup. Scoped by RLS to the current tenant — the
   * same provider identity can exist in two tenants without
   * collision; this query only sees the one in scope.
   */
  async findByProviderIdentity(
    provider: string,
    providerUserId: string,
  ): Promise<TenantedSocialAccount | null> {
    const table = quoteIdent(tenantedSocialAccountSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table}
       WHERE "provider" = $1 AND "provider_user_id" = $2
       LIMIT 1`,
      [provider, providerUserId],
    )
    if (rows.length === 0) return null
    return this.hydrate(rows[0]!)
  }
}
