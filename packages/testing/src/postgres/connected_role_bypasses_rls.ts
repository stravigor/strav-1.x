/**
 * `true` when the connected role is a Postgres SUPERUSER or has the
 * BYPASSRLS attribute. Such roles ignore `ENABLE ROW LEVEL SECURITY` —
 * even with `FORCE ROW LEVEL SECURITY` set on a table — so
 * RLS-isolation assertions can't pass under them. Tests use this to
 * self-skip the RLS-scoping check while still exercising the rest of
 * the tenancy path.
 *
 * Production setups should run the app under a non-privileged role and
 * keep BYPASSRLS reserved for the admin pool (`TenantManager`'s
 * `adminDb`). Local-dev / CI databases often share one superuser for
 * convenience — this helper lets the suite degrade gracefully there.
 */

import type { PostgresDatabase } from '@strav/database'

export async function connectedRoleBypassesRls(db: PostgresDatabase): Promise<boolean> {
  const row = await db.queryOne<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  )
  return Boolean(row?.rolsuper) || Boolean(row?.rolbypassrls)
}
