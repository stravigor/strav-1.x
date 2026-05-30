/**
 * `SocialAccountRepository` — domain helpers on top of the
 * generic CRUD surface. The four methods apps actually use:
 *
 *   - `connect({ userId, provider, profile, tokens })` — upsert
 *     by `(provider, provider_user_id)` within the tenant scope.
 *     Runs on every sign-in: a returning user's tokens get
 *     refreshed; a first-time link inserts.
 *
 *   - `disconnect({ userId, provider })` — delete the link.
 *     Apps invoke this when the user unlinks a provider; for
 *     full token revocation, drivers' `revoke()` runs separately
 *     (this method doesn't reach the provider).
 *
 *   - `findByUser(userId)` — list every linked provider for a
 *     user. Apps render account-settings UIs from this.
 *
 *   - `findByProviderIdentity(provider, providerUserId)` — the
 *     sign-in lookup: "we just verified an OAuth identity, who
 *     does it belong to?" Returns the row including `user_id`
 *     so the caller can hydrate the app's User.
 *
 * Tokens are encrypted via the Model's `@encrypt` decorators —
 * Repository hydration handles it transparently. Apps must have
 * an `EncryptionProvider` registered; otherwise the first
 * encrypt/decrypt throws `ConfigError`.
 */

import { quoteIdent, Repository } from '@strav/database'
import { ulid } from '@strav/kernel'
import type { OAuthTokens, SocialProfile } from '../dto/index.ts'
import { SocialAccount } from './social_account.ts'
import { socialAccountSchema } from './social_account_schema.ts'

export interface ConnectInput {
  /** App-side user id. */
  userId: string
  /** Provider-instance name (matches `social.use(name)`). Distinct from `profile.provider` when one driver is wired under multiple names. */
  provider: string
  profile: SocialProfile
  tokens: OAuthTokens
}

export interface DisconnectInput {
  userId: string
  provider: string
}

export class SocialAccountRepository extends Repository<SocialAccount> {
  static override readonly schema = socialAccountSchema
  static override readonly model = SocialAccount

  /**
   * Upsert a social account by `(provider, provider_user_id)`.
   * Insert on first link; update tokens + cached profile fields
   * on subsequent sign-ins.
   *
   * No tenant scoping required — the default schema is
   * non-tenanted. Apps that opted into the tenanted variant
   * (`@strav/social/tenanted`) wrap calls in
   * `TenantManager.withTenant(...)`; that variant ships its own
   * Repository.
   */
  async connect(input: ConnectInput): Promise<SocialAccount> {
    const existing = await this.findByProviderIdentity(
      input.provider,
      input.profile.id,
    )
    const now = new Date()

    if (existing) {
      // Cross-user link guard: if the existing row belongs to a
      // different user, refuse — the app needs to resolve the
      // conflict explicitly (typically "this Google account is
      // already linked to another user").
      if (existing.user_id !== input.userId) {
        throw new SocialAccountAlreadyLinkedError({
          provider: input.provider,
          providerUserId: input.profile.id,
          existingUserId: existing.user_id,
          attemptedUserId: input.userId,
        })
      }
      // Same user, returning sign-in: refresh tokens + cached
      // profile fields via the standard Repository.update path
      // (handles `@cast` / `@encrypt` round-trips for us).
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
      } as Partial<SocialAccount>)
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
    } as Partial<SocialAccount>)
  }

  /** Delete the link. No-op when nothing matches. */
  async disconnect(input: DisconnectInput): Promise<void> {
    const table = quoteIdent(socialAccountSchema.name)
    await this.db.execute(
      `DELETE FROM ${table} WHERE "user_id" = $1 AND "provider" = $2`,
      [input.userId, input.provider],
    )
  }

  /** Every social account linked to one user. */
  async findByUser(userId: string): Promise<SocialAccount[]> {
    const table = quoteIdent(socialAccountSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE "user_id" = $1 ORDER BY "created_at"`,
      [userId],
    )
    return Promise.all(rows.map((r) => this.hydrate(r)))
  }

  /** Single (user, provider) lookup. */
  async findByUserAndProvider(
    userId: string,
    provider: string,
  ): Promise<SocialAccount | null> {
    const table = quoteIdent(socialAccountSchema.name)
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE "user_id" = $1 AND "provider" = $2 LIMIT 1`,
      [userId, provider],
    )
    if (rows.length === 0) return null
    return this.hydrate(rows[0]!)
  }

  /**
   * The sign-in lookup: given an OAuth identity, find the user
   * it belongs to. Returns the account row (which includes
   * `user_id`) or `null` when no link exists.
   */
  async findByProviderIdentity(
    provider: string,
    providerUserId: string,
  ): Promise<SocialAccount | null> {
    const table = quoteIdent(socialAccountSchema.name)
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

/**
 * Thrown when an OAuth identity is already linked to a DIFFERENT
 * user than the caller is trying to attach it to. Apps catch this
 * and surface a UI ("this Google account is already linked to
 * <other_email>"). The framework refuses to silently move the
 * link or fork the row.
 */
export class SocialAccountAlreadyLinkedError extends Error {
  readonly provider: string
  readonly providerUserId: string
  readonly existingUserId: string
  readonly attemptedUserId: string

  constructor(info: {
    provider: string
    providerUserId: string
    existingUserId: string
    attemptedUserId: string
  }) {
    super(
      `SocialAccount: provider "${info.provider}" identity "${info.providerUserId}" is already linked to user "${info.existingUserId}"; refusing to relink to "${info.attemptedUserId}".`,
    )
    this.name = 'SocialAccountAlreadyLinkedError'
    this.provider = info.provider
    this.providerUserId = info.providerUserId
    this.existingUserId = info.existingUserId
    this.attemptedUserId = info.attemptedUserId
  }
}
