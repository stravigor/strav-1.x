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
 * For tenanted schemas whose PK is `tenantedBigSerial`, the emitter
 * also wires per-tenant sequencing: a composite `PRIMARY KEY
 * (tenant_id, id)`, a `BEFORE INSERT` trigger that allocates the next
 * id for the current tenant, and a small shared infrastructure
 * (`_strav_tenant_sequences` counter table + `_strav_next_tenant_id`
 * SQL function). All idempotent — running the same migration twice is
 * safe. See {@link emitTenantedBigSerialSetup}.
 *
 * Deferred to follow-up slices:
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
    // FORCE makes RLS apply even to the table owner. Without it Postgres
    // exempts the owner role (which migrations run as), so a deployment
    // that runs migrations + the app under the same role would silently
    // see cross-tenant rows. The admin / migration paths that legitimately
    // need to ignore RLS go through `TenantManager.withoutTenant`, which
    // routes through the BYPASSRLS connection pool when one is configured.
    `ALTER TABLE ${quoteIdent(schema.name)} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${quoteIdent(schema.name)} USING (${quoteIdent(colName)} = ${tenantExpr}) WITH CHECK (${quoteIdent(colName)} = ${tenantExpr})`,
  ].join(';\n')
}

/**
 * SQL for the per-tenant sequencing layer: a shared counter table
 * (`_strav_tenant_sequences`) + an atomic `_strav_next_tenant_id`
 * function + a per-table `BEFORE INSERT` trigger that calls into them,
 * plus the composite `PRIMARY KEY (tenant_id, id)` constraint that
 * makes ids per-tenant rather than global.
 *
 * The shared infrastructure is `CREATE TABLE IF NOT EXISTS` +
 * `CREATE OR REPLACE FUNCTION`, so re-running a migration that
 * recreates a tenantedBigSerial table is safe — only the per-table
 * trigger drops + recreates to pick up any signature changes.
 *
 * Tenant ids are passed as `text` into the counter (cast at the
 * trigger boundary). This keeps the shared table type-uniform
 * regardless of whether the registry's PK is `char(26)` ULID, `bigint`
 * BIGSERIAL, or anything else — string equality is the universal join
 * key.
 */
export function emitTenantedBigSerialSetup(
  schema: Schema,
  registry: SchemaRegistry | undefined,
): string {
  const tenantReg = tenantRegistrySchema(registry)
  const tenantCol = tenantIdColumnName(tenantReg)
  const triggerFn = `${schema.name}_assign_tenant_id`
  const triggerName = `${schema.name}_assign_tenant_id_trigger`
  const pkConstraint = `${schema.name}_pkey`
  return [
    // Shared counter table — one row per (table, tenant) pair.
    `CREATE TABLE IF NOT EXISTS "_strav_tenant_sequences" (
  table_name text NOT NULL,
  tenant_id text NOT NULL,
  last_id bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (table_name, tenant_id)
)`,
    // Atomic next-id allocator. ON CONFLICT DO UPDATE locks the row,
    // increments, returns — single statement, no race window.
    `CREATE OR REPLACE FUNCTION "_strav_next_tenant_id"(p_table text, p_tenant_id text)
RETURNS bigint AS $$
DECLARE
  next_id bigint;
BEGIN
  INSERT INTO "_strav_tenant_sequences" (table_name, tenant_id, last_id)
  VALUES (p_table, p_tenant_id, 1)
  ON CONFLICT (table_name, tenant_id) DO UPDATE
  SET last_id = "_strav_tenant_sequences".last_id + 1
  RETURNING last_id INTO next_id;
  RETURN next_id;
END;
$$ LANGUAGE plpgsql`,
    // Per-table trigger function — fires before each INSERT, replacing
    // id=0 (the DEFAULT) with the freshly-allocated next-id for
    // (table, tenant). User-supplied non-zero ids pass through
    // untouched (useful for tests and seed data).
    `CREATE OR REPLACE FUNCTION ${quoteIdent(triggerFn)}() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS NULL OR NEW.id = 0 THEN
    NEW.id := "_strav_next_tenant_id"(TG_TABLE_NAME, NEW.${quoteIdent(tenantCol)}::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
    // Drop+create the trigger so re-running a migration picks up any
    // signature changes (CREATE OR REPLACE TRIGGER is PG14+, but
    // DROP IF EXISTS + CREATE is portable to PG12+).
    `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)} ON ${quoteIdent(schema.name)}`,
    `CREATE TRIGGER ${quoteIdent(triggerName)} BEFORE INSERT ON ${quoteIdent(schema.name)} FOR EACH ROW EXECUTE FUNCTION ${quoteIdent(triggerFn)}()`,
    // Composite PK — replaces the inline-PK constraint that the column
    // definition would otherwise emit (column emits as plain
    // `bigint NOT NULL DEFAULT 0` for `tenantedBigSerial`).
    `ALTER TABLE ${quoteIdent(schema.name)} ADD CONSTRAINT ${quoteIdent(pkConstraint)} PRIMARY KEY (${quoteIdent(tenantCol)}, "id")`,
  ].join(';\n')
}
