/**
 * Tenancy-aware DDL helpers.
 *
 * Schemas marked `tenanted: true` get two things at CREATE TABLE time:
 *   1. A tenant FK column injected right after the PK. The column is
 *      named `<tenant_registry_name>_id` (so a registry called `tenant`
 *      produces `tenant_id`, called `org` produces `org_id`), NOT NULL,
 *      ON DELETE CASCADE. Same SQL type as the registry's PK.
 *   2. Row-level security policies — `ENABLE ROW LEVEL SECURITY` plus a
 *      `CREATE POLICY` that scopes every read + write by
 *      `current_setting('app.tenant_id')`.
 *
 * Both pieces require a `SchemaRegistry` because the tenant-registry's
 * name + PK type are needed. The emitter throws a loud `ConfigError`-
 * shaped Error if no registry is supplied or no `tenantRegistry: true`
 * schema is registered — better than silently emitting a tenanted
 * table that can never be queried.
 *
 * Deferred to follow-up slices:
 *   - **Composite (tenant_id, id) PK for `tenantedSerial`.** Today's
 *     tenanted schemas should use `t.id()` (ULID) — globally unique
 *     by construction, so the tenant_id column is just a scoping FK,
 *     not part of the PK.
 *   - **Schema-diff awareness.** The diff engine doesn't know about
 *     tenancy yet; it would emit a tenanted-table's CREATE TABLE with
 *     the RLS plumbing fine (via the upgraded emitter), but it
 *     doesn't detect "this existing table is missing its tenant_id
 *     column / RLS policy."
 *   - **Two-role connection config.** Migrations need a BYPASSRLS role
 *     to add the tenant_id column (which has NOT NULL — would block
 *     INSERTs from the app role if RLS is already on). Apps wire this
 *     manually today.
 */

import { quoteIdent } from '../orm/sql_emitter.ts'
import type { Schema, SchemaField } from '../schema/types.ts'
import type { SchemaRegistry } from '../schema_registry.ts'
import { findPrimaryKey, sqlTypeFor } from './sql_type.ts'

/**
 * The schema that's flagged `tenantRegistry: true`. Throws when no
 * registry is supplied or no registry schema is registered — apps must
 * declare exactly one tenant registry before any `tenanted: true`
 * schema can be emitted.
 */
export function tenantRegistrySchema(registry: SchemaRegistry | undefined): Schema {
  if (!registry) {
    throw new Error(
      'Tenancy: a SchemaRegistry is required for tenanted schemas — pass `{ registry }` in EmitOptions ' +
        'and ensure one of your schemas is declared with `{ tenantRegistry: true }`.',
    )
  }
  const tenantReg = registry.all().find((s) => s.tenancy.tenantRegistry === true)
  if (!tenantReg) {
    throw new Error(
      'Tenancy: no schema is declared with `{ tenantRegistry: true }`. ' +
        'Exactly one schema (typically the `tenant` table) must carry that flag — the framework derives ' +
        'the tenant FK column name and PK type from it.',
    )
  }
  return tenantReg
}

/** Name of the auto-injected FK column on tenanted schemas. */
export function tenantIdColumnName(tenantReg: Schema): string {
  return `${tenantReg.name}_id`
}

/**
 * The Schema-shaped descriptor of the injected column. Same shape any
 * `t.reference(...)` produces, so the column-definition emitter handles
 * it without special-casing.
 */
export function tenantIdColumnField(tenantReg: Schema): SchemaField {
  return {
    name: tenantIdColumnName(tenantReg),
    kind: 'reference',
    nullable: false,
    unique: false,
    hasDefault: false,
    default: undefined,
    order: -1, // synthetic; placed manually
    references: tenantReg.name,
    onDelete: 'cascade',
  }
}

/**
 * SQL for `ENABLE ROW LEVEL SECURITY` + a single tenant-isolation
 * policy. Returns the statement list joined by `;\n` — `Database.execute`
 * handles multi-statement strings.
 *
 * The policy scopes USING + WITH CHECK by `current_setting('app.tenant_id')`,
 * cast to the tenant registry's PK type. So `bigint` PKs get a numeric
 * cast, `char(26)` ULID PKs stay text, etc.
 */
export function emitRlsForTenanted(schema: Schema, registry: SchemaRegistry | undefined): string {
  const tenantReg = tenantRegistrySchema(registry)
  const tenantPk = findPrimaryKey(tenantReg)
  // `bigserial` is a pseudo-type — the runtime column is `bigint` + a
  // sequence. Cast targets must be the resolved storage type.
  const storedType = sqlTypeFor(tenantPk, registry)
  const castType = storedType === 'bigserial' ? 'bigint' : storedType
  const colName = tenantIdColumnName(tenantReg)
  const policyName = `${schema.name}_tenant_isolation`
  const tenantExpr = `current_setting('app.tenant_id')::${castType}`
  return [
    `ALTER TABLE ${quoteIdent(schema.name)} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${quoteIdent(schema.name)} USING (${quoteIdent(colName)} = ${tenantExpr}) WITH CHECK (${quoteIdent(colName)} = ${tenantExpr})`,
  ].join(';\n')
}
