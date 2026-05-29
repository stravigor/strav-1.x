#!/usr/bin/env bun
/**
 * Provision two test roles on the local Postgres:
 *
 *   - `strav_app`   — NOSUPERUSER, NOBYPASSRLS, LOGIN. The app role.
 *                     RLS policies apply to this role, so the integration
 *                     suite's cross-tenant isolation assertions actually
 *                     exercise the policy machinery instead of self-skipping
 *                     under a privileged role.
 *   - `strav_admin` — NOSUPERUSER, BYPASSRLS, LOGIN. The admin / migration
 *                     role. `TenantManager.withoutTenant` routes through
 *                     a pool with this role when `config.database.admin` is
 *                     configured, so admin paths can read across tenants
 *                     without disabling RLS globally.
 *
 * Why bother: a single-superuser local-dev setup bypasses RLS entirely (even
 * `FORCE ROW LEVEL SECURITY`), so the integration tests degrade their
 * tenant-scoping assertions to "did the tenant_id get set". Provisioning a
 * dedicated NOBYPASSRLS app role makes those assertions real.
 *
 * Idempotent: re-running is a no-op when the roles already exist.
 *
 * Connects as the user specified by env (typically a superuser — the script
 * needs CREATE ROLE privilege). Run:
 *
 *   bun scripts/db-setup-roles.ts
 *   # or
 *   bun run db:setup-roles
 *
 * Then point your integration suite at the app role:
 *
 *   DB_USER=strav_app DB_PASSWORD=strav_app DB_DATABASE=strav bun test
 *
 * Customize the role passwords via `STRAV_APP_PASSWORD` / `STRAV_ADMIN_PASSWORD`
 * env vars (default: `strav_app` / `strav_admin`).
 */

import { SQL } from 'bun'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`db-setup-roles: missing env var ${name}. Source .env.test (see .env.test.example).`)
    process.exit(1)
  }
  return value
}

const host = requireEnv('DB_HOST')
const port = requireEnv('DB_PORT')
const user = requireEnv('DB_USER')
const password = requireEnv('DB_PASSWORD')
const database = requireEnv('DB_DATABASE')

const appPassword = process.env.STRAV_APP_PASSWORD ?? 'strav_app'
const adminPassword = process.env.STRAV_ADMIN_PASSWORD ?? 'strav_admin'

const url = `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`
const sql = new SQL(url, { max: 1 })

// Inline literal passwords — `CREATE ROLE` doesn't accept bind parameters
// for PASSWORD. Single-quote escape is enough for the controlled env vars
// here; the script is dev-only and rejects shell-special chars below.
function quoteLiteral(s: string): string {
  if (/[\n\r\t]/.test(s)) {
    throw new Error(`db-setup-roles: role password may not contain whitespace control chars`)
  }
  return `'${s.replace(/'/g, "''")}'`
}

async function ensureRole(role: string, pw: string, bypassRls: boolean): Promise<void> {
  const exists = await sql.unsafe<{ rolname: string }[]>(
    `SELECT rolname FROM pg_roles WHERE rolname = '${role}'`,
  )
  if (exists.length > 0) {
    // Refresh password + attributes so re-running picks up an env var change.
    await sql.unsafe(
      `ALTER ROLE "${role}" WITH LOGIN ${bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'} NOSUPERUSER PASSWORD ${quoteLiteral(pw)}`,
    )
    console.log(`db-setup-roles: ${role} updated`)
    return
  }
  await sql.unsafe(
    `CREATE ROLE "${role}" WITH LOGIN ${bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'} NOSUPERUSER PASSWORD ${quoteLiteral(pw)}`,
  )
  console.log(`db-setup-roles: ${role} created`)
}

async function grantSchema(role: string): Promise<void> {
  // CREATE on the database lets the role `CREATE SCHEMA public` after
  // resetSchema()'s DROP. CONNECT alone is insufficient — `permission
  // denied for database` would fire on the first CREATE SCHEMA.
  await sql.unsafe(`GRANT CONNECT, CREATE ON DATABASE "${database}" TO "${role}"`)
  await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO "${role}"`)
  // Default privs so future tables (created by the connecting user during
  // tests) are immediately usable by both roles. The integration suite
  // creates tables as the connecting user — usually `strav_app` itself once
  // the env is pointed at it — so these defaults make the roles
  // interchangeable on the test data.
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${role}"`,
  )
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${role}"`,
  )
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${role}"`,
  )
  await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${role}"`)
  await sql.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
}

try {
  console.log(`db-setup-roles: provisioning roles on ${host}:${port}/${database}…`)
  await ensureRole('strav_app', appPassword, /* bypassRls */ false)
  await ensureRole('strav_admin', adminPassword, /* bypassRls */ true)
  await grantSchema('strav_app')
  await grantSchema('strav_admin')
  // Hand the public schema to strav_app so resetSchema() can DROP/CREATE
  // it without superuser. FORCE ROW LEVEL SECURITY still applies to the
  // schema owner, so RLS-scoping assertions continue to exercise the
  // policy. Without this, tests run as strav_app fail at setup with
  // `must be owner of schema public`.
  await sql.unsafe(`ALTER SCHEMA public OWNER TO "strav_app"`)
  console.log('db-setup-roles: public schema owner → strav_app')
  console.log('db-setup-roles: done.')
  console.log('')
  console.log('Next: point the integration suite at the app role.')
  console.log('  DB_USER=strav_app DB_PASSWORD=' + appPassword + ' bun test')
  await sql.close({ timeout: 2 })
  process.exit(0)
} catch (err) {
  console.error('db-setup-roles: failed:', (err as Error).message)
  await sql.close({ timeout: 2 }).catch(() => undefined)
  process.exit(1)
}
