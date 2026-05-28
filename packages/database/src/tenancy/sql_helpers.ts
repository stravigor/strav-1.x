/**
 * Postgres SQL-level tenancy helpers — generated DDL apps execute as
 * part of their tenancy migration.
 *
 * Today there's one helper: `current_tenant_id()`. The framework's RLS
 * policies use the inline form `current_setting('app.tenant_id')::<type>`
 * — but raw-SQL paths in app code often want a typed function call
 * instead:
 *
 * ```sql
 * SELECT * FROM "post" WHERE "tenant_id" = current_tenant_id()
 * ```
 *
 * That's more readable than the inline cast and (because the function
 * is `STABLE`) Postgres can optimize across calls in the same query.
 * The `true` second arg to `current_setting` makes it return NULL
 * instead of raising when the GUC isn't bound — so queries outside
 * `withTenant` get a `WHERE tenant_id = NULL` predicate that matches
 * nothing (defensive failure, same as the RLS policy semantic).
 */

import type { EmittedDdl } from '../ddl/index.ts'
import { findPrimaryKey, sqlTypeFor, tenantRegistrySchema } from '../ddl/index.ts'
import type { SchemaRegistry } from '../schema_registry.ts'

/**
 * Emit `CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS <pk_type>
 * AS … STABLE`. The return type matches the tenant registry's PK type
 * (resolved via the SchemaRegistry).
 *
 * Apps include this in their tenancy migration:
 *
 * ```ts
 * async up(db) {
 *   await db.execute(emitCreateTable(tenantSchema, { registry }).sql)
 *   await db.execute(emitCreateTable(postSchema, { registry }).sql)
 *   await db.execute(emitTenantIdFunction(registry).sql)
 * }
 * ```
 *
 * After that, raw-SQL paths can use `current_tenant_id()` directly:
 *
 * ```ts
 * await tx.query('SELECT * FROM "post" WHERE "tenant_id" = current_tenant_id()')
 * ```
 *
 * `bigserial` PKs are normalized to `bigint` (same as the RLS-policy
 * emitter does) since `bigserial` is a pseudo-type — the actual column
 * is `bigint` + a sequence.
 */
export function emitTenantIdFunction(registry: SchemaRegistry | undefined): EmittedDdl {
  const tenantReg = tenantRegistrySchema(registry)
  const pkField = findPrimaryKey(tenantReg)
  const storedType = sqlTypeFor(pkField, registry)
  const castType = storedType === 'bigserial' ? 'bigint' : storedType
  return {
    sql:
      `CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS ${castType} AS $$\n` +
      `  SELECT current_setting('app.tenant_id', true)::${castType}\n` +
      `$$ LANGUAGE sql STABLE`,
  }
}
