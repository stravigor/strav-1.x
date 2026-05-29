/**
 * M7 end-to-end smoke — proves `@strav/social` against a real
 * Postgres instance.
 *
 * Wire under test:
 *
 *   ConfigProvider → LoggerProvider → DatabaseProvider →
 *   EncryptionProvider → SocialProvider → LineSocialProvider
 *
 *   Real Postgres holds the `social_account` table created by
 *   `applySocialAccountMigration` (default, non-tenanted). The
 *   Line driver runs against a stubbed `fetch` so token /
 *   profile requests resolve locally (no network).
 *
 *   - Apply the default migration.
 *   - Drive the full `authorize → exchange → profile` flow.
 *   - `connect(...)` upserts via `SocialAccountRepository`;
 *     `findByProviderIdentity(...)` resolves the user back.
 *   - Re-sign in: tokens refresh, no new row inserted.
 *   - Cross-user link attempt: `SocialAccountAlreadyLinkedError`.
 *   - Encrypted token round-trip: the persisted bytes are NOT
 *     plaintext, but the hydrated `access_token` IS the original
 *     string.
 *
 * The opt-in tenanted variant (`@strav/social/tenanted`)
 * follows the identical flow inside `TenantManager.withTenant(...)`
 * — schema + migration are validated by the unit suite (slice
 * 8.5); the runtime path mirrors the default exercised here.
 *
 * Self-skips when no Postgres is available.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  DatabaseProvider,
  PostgresDatabase,
  SchemaRegistry,
  TenantManager,
  emitCreateTable,
} from '@strav/database'
import {
  Application,
  Cipher,
  ConfigProvider,
  EncryptionProvider,
  EventBus,
  LoggerProvider,
  ServiceProvider,
  ulid,
} from '@strav/kernel'
import {
  applySocialAccountMigration,
  type OAuthTokens,
  type SocialProfile,
  SocialAccountAlreadyLinkedError,
  SocialAccountRepository,
  SocialManager,
  SocialProvider,
  socialAccountSchema,
} from '@strav/social'
import { LineSocialDriver, LineSocialProvider } from '@strav/social/line'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../../support/postgres_test_db.ts'
import { tenantSchema } from './tenant_schema.ts'

const PG_AVAILABLE = await isPostgresAvailable()

const ENCRYPTION_KEY_HEX = Buffer.from(randomBytes(32)).toString('hex')

// ─── Stub Line OAuth backend ─────────────────────────────────────────────

interface StubProfile {
  userId: string
  displayName: string
  pictureUrl?: string
}

function lineStubFetch(profileByCode: Map<string, StubProfile>): typeof fetch {
  let nextAt = 0
  let nextRt = 0
  const tokenToProfile = new Map<string, StubProfile>()
  const fn = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/oauth2/v2.1/token')) {
      const body = new URLSearchParams((init?.body as string) ?? '')
      const grant = body.get('grant_type')
      if (grant === 'authorization_code') {
        const code = body.get('code')!
        const profile = profileByCode.get(code)
        if (!profile) {
          return new Response('{"error":"invalid_grant"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        nextAt += 1
        nextRt += 1
        const accessToken = `AT_${nextAt}_${profile.userId}`
        const refreshToken = `RT_${nextRt}_${profile.userId}`
        tokenToProfile.set(accessToken, profile)
        return new Response(
          JSON.stringify({
            access_token: accessToken,
            expires_in: 2592000,
            refresh_token: refreshToken,
            id_token: 'header.eyJlbWFpbCI6Im5vQGwuY28ifQ.sig',
            scope: 'openid profile',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{"error":"unsupported"}', { status: 400 })
    }
    if (url.includes('/v2/profile')) {
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
      const token = auth.replace(/^Bearer /, '')
      const profile = tokenToProfile.get(token)
      if (!profile) return new Response('{"error":"invalid"}', { status: 401 })
      return new Response(
        JSON.stringify({
          userId: profile.userId,
          displayName: profile.displayName,
          ...(profile.pictureUrl ? { pictureUrl: profile.pictureUrl } : {}),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 404 })
  }
  return fn as unknown as typeof fetch
}

// ─── Bootstrap providers ────────────────────────────────────────────────

class SocialAppProvider extends ServiceProvider {
  override readonly name = 'social-app'
  override readonly dependencies = ['social', 'database']

  override register(app: Application): void {
    app.singleton(SchemaRegistry, () =>
      new SchemaRegistry().registerAll([tenantSchema, socialAccountSchema]),
    )
    app.singleton(
      TenantManager,
      (c) => new TenantManager(c.resolve(PostgresDatabase), c.resolve(EventBus)),
    )
    app.singleton(
      SocialAccountRepository,
      (c) =>
        new SocialAccountRepository(
          c.resolve(PostgresDatabase),
          c.resolve(EventBus),
          c.resolve(SchemaRegistry),
          c.resolve(Cipher),
        ),
    )
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('M7 e2e: @strav/social against Postgres', () => {
  let app: Application
  let setupDb: PostgresDatabase
  let manager: SocialManager
  let accounts: SocialAccountRepository
  let profileByCode: Map<string, StubProfile>

  beforeAll(async () => {
    setupDb = createTestDatabase()
    await resetSchema(setupDb)

    const registry = new SchemaRegistry().registerAll([
      tenantSchema,
      socialAccountSchema,
    ])
    await setupDb.execute(emitCreateTable(tenantSchema, { registry }).sql)
    await applySocialAccountMigration(setupDb, { registry })

    app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'main',
          level: 'silent',
          channels: { main: { driver: 'stderr' } },
        },
        database: {
          url: `postgres://${process.env.DB_USER}:${encodeURIComponent(
            process.env.DB_PASSWORD as string,
          )}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
        },
        encryption: { key: ENCRYPTION_KEY_HEX },
        social: {
          default: 'line',
          providers: {
            line: {
              driver: 'line',
              clientId: 'e2e_client_id',
              clientSecret: 'e2e_client_secret',
            },
          },
        },
      }),
      new LoggerProvider(),
      new EncryptionProvider(),
      new DatabaseProvider(),
      new SocialProvider(),
      new LineSocialProvider(),
      new SocialAppProvider(),
    ])
    await app.start({ signalHandlers: false })

    // Hand-wire a stub-backed Line driver so token + profile
    // calls resolve locally. Bypasses the LineSocialProvider's
    // factory + the ConfigRepository deep-clone path that
    // doesn't tolerate non-cloneable members.
    manager = app.resolve(SocialManager)
    profileByCode = new Map()
    manager.useDriver(
      'line',
      new LineSocialDriver({
        instanceName: 'line',
        config: {
          driver: 'line',
          clientId: 'e2e_client_id',
          clientSecret: 'e2e_client_secret',
          fetch: lineStubFetch(profileByCode),
        },
      }),
    )

    accounts = app.resolve(SocialAccountRepository)
  })

  afterAll(async () => {
    await app?.shutdown()
    await setupDb?.close({ timeout: 2 })
  })

  // ─── Schema sanity ──────────────────────────────────────────────────

  test('migration created the social_account table + non-tenanted indexes', async () => {
    const tables = await setupDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'social_account'`,
    )
    expect(tables.length).toBe(1)

    const columns = await setupDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'social_account'`,
    )
    const colNames = columns.map((c) => c.column_name)
    // Framework policy: multitenancy is opt-in — default schema has NO tenant_id column.
    expect(colNames).not.toContain('tenant_id')

    const indexes = await setupDb.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'social_account'`,
    )
    const idxNames = indexes.map((i) => i.indexname)
    expect(idxNames).toContain('idx_social_account_provider_identity')
    expect(idxNames).toContain('idx_social_account_user_provider')
    expect(idxNames).toContain('idx_social_account_user')
  })

  // ─── End-to-end Line sign-in ─────────────────────────────────────────

  test('full Line authorize → exchange → profile → connect → find round-trip', async () => {
    profileByCode.set('code_alice_1', { userId: 'U_alice', displayName: 'Alice' })

    const { url, state, codeVerifier } = await manager.authorize({
      redirectUri: 'https://app.test/auth/line/cb',
      scopes: ['openid', 'profile'],
    })
    expect(url).toContain('access.line.me')
    expect(state).toBeTruthy()

    const tokens = await manager.exchange({
      code: 'code_alice_1',
      redirectUri: 'https://app.test/auth/line/cb',
      state,
      expectedState: state,
      ...(codeVerifier !== undefined ? { codeVerifier } : {}),
    })
    expect(tokens.accessToken.startsWith('AT_')).toBe(true)
    const profile = await manager.profile(tokens.accessToken)
    expect(profile.id).toBe('U_alice')
    expect(profile.name).toBe('Alice')

    const userId = ulid()
    const account = await accounts.connect({
      userId,
      provider: 'line',
      profile,
      tokens,
    })
    expect(account.user_id).toBe(userId)
    expect(account.provider_user_id).toBe('U_alice')
    expect(account.access_token).toBe(tokens.accessToken)

    const back = await accounts.findByProviderIdentity('line', 'U_alice')
    expect(back?.user_id).toBe(userId)
    expect(back?.access_token).toBe(tokens.accessToken)
  })

  // ─── Encryption round-trip ──────────────────────────────────────────

  test('persisted bytes are encrypted; hydrated value is plaintext', async () => {
    const account = await accounts.findByProviderIdentity('line', 'U_alice')
    expect(account).not.toBeNull()
    // Raw bytea on disk must NOT contain the plaintext token.
    const rows = await setupDb.query<{ access_token: Buffer }>(
      `SELECT access_token FROM social_account WHERE id = $1`,
      [account!.id],
    )
    const raw = rows[0]?.access_token
    expect(raw).toBeDefined()
    const asText = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    expect(asText).not.toContain('AT_')
    // The hydrated model has the plaintext.
    expect(account!.access_token.startsWith('AT_')).toBe(true)
  })

  // ─── Re-sign-in refreshes tokens, no new row ────────────────────────

  test('re-connect with same user + provider updates tokens, no duplicate row', async () => {
    profileByCode.set('code_alice_2', { userId: 'U_alice', displayName: 'Alice' })
    const initial = await accounts.findByProviderIdentity('line', 'U_alice')
    expect(initial).not.toBeNull()
    const initialId = initial!.id

    const tokens2 = await manager.exchange({
      code: 'code_alice_2',
      redirectUri: 'https://app.test/auth/line/cb',
      state: 's',
      expectedState: 's',
      codeVerifier: undefined,
    } as never)
    const profile2 = await manager.profile(tokens2.accessToken)
    const updated = await accounts.connect({
      userId: initial!.user_id,
      provider: 'line',
      profile: profile2,
      tokens: tokens2,
    })
    expect(updated.id).toBe(initialId) // same row
    expect(updated.access_token).toBe(tokens2.accessToken) // refreshed
    expect(updated.access_token).not.toBe(initial!.access_token)

    const list = await accounts.findByUser(initial!.user_id)
    expect(list.length).toBe(1)
  })

  // ─── Cross-user link guard ──────────────────────────────────────────

  test('SocialAccountAlreadyLinkedError when a different user attempts to link the same identity', async () => {
    profileByCode.set('code_alice_3', { userId: 'U_alice', displayName: 'Alice' })
    const tokens3 = await manager.exchange({
      code: 'code_alice_3',
      redirectUri: 'https://app.test/auth/line/cb',
      state: 's',
      expectedState: 's',
      codeVerifier: undefined,
    } as never)
    const profile3 = await manager.profile(tokens3.accessToken)

    const attemptingUserId = ulid()
    await expect(
      accounts.connect({
        userId: attemptingUserId,
        provider: 'line',
        profile: profile3,
        tokens: tokens3,
      }),
    ).rejects.toThrow(SocialAccountAlreadyLinkedError)
  })

  // ─── findByUser + disconnect ────────────────────────────────────────

  test('disconnect removes the row + findByUser reflects it', async () => {
    // Make a fresh user + linked identity to disconnect.
    profileByCode.set('code_bob', { userId: 'U_bob', displayName: 'Bob' })
    const tokensBob = await manager.exchange({
      code: 'code_bob',
      redirectUri: 'https://app.test/auth/line/cb',
      state: 's',
      expectedState: 's',
      codeVerifier: undefined,
    } as never)
    const profileBob = await manager.profile(tokensBob.accessToken)
    const bobUserId = ulid()
    await accounts.connect({
      userId: bobUserId,
      provider: 'line',
      profile: profileBob,
      tokens: tokensBob,
    })
    expect((await accounts.findByUser(bobUserId)).length).toBe(1)

    await accounts.disconnect({ userId: bobUserId, provider: 'line' })
    expect((await accounts.findByUser(bobUserId)).length).toBe(0)
    expect(await accounts.findByProviderIdentity('line', 'U_bob')).toBeNull()
  })

})
