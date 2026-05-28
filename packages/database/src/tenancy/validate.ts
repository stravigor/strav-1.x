/**
 * Boot-time tenancy validation. Catches the common production
 * misconfigurations BEFORE the first query hits a confusing Postgres
 * error (e.g., RLS policy comparing `bigint = text` because the
 * registry's PK type isn't what the schema declared).
 *
 * Apps call this from their start path, typically after `app.start()`:
 *
 * ```ts
 * await app.start()
 * await validateTenantRegistry(app.resolve(PostgresDatabase), app.resolve(SchemaRegistry))
 * app.resolve(HttpKernel).serve(...)
 * ```
 *
 * Opt-in by design — apps that don't use tenancy (no `tenanted: true`
 * schemas) skip the call. When tenanted schemas ARE declared but the
 * registry isn't, the validation throws with a clear pointer.
 *
 * What's checked:
 *   1. If any `tenanted: true` schema is registered, exactly one
 *      `tenantRegistry: true` schema must be too.
 *   2. The registry's table must exist in the live DB.
 *   3. The registry's PK column type in the DB must match what the
 *      schema declared (e.g., `char(26)` for `t.id()`, `uuid` for
 *      `t.uuid()`, `bigint` for `t.bigSerial()`).
 *
 * Throws `ConfigError` on any mismatch with a message that names the
 * specific check and the observed-vs-expected types.
 */

import { ConfigError } from '@strav/kernel'
import type { DatabaseExecutor } from '../database.ts'
import { findPrimaryKey, sqlTypeFor } from '../ddl/index.ts'
import type { SchemaRegistry } from '../schema_registry.ts'

interface PgColumn {
  data_type: string
  character_maximum_length: number | null
}

export async function validateTenantRegistry(
  db: DatabaseExecutor,
  registry: SchemaRegistry,
): Promise<void> {
  const all = registry.all()
  const tenanted = all.filter((s) => s.tenancy.tenanted)
  const registries = all.filter((s) => s.tenancy.tenantRegistry)

  if (tenanted.length === 0) return // No tenancy → nothing to validate.

  if (registries.length === 0) {
    throw new ConfigError(
      `validateTenantRegistry: ${tenanted.length} schema(s) declared \`tenanted: true\` but no schema is declared with \`{ tenantRegistry: true }\`. Exactly one schema must be the tenant registry.`,
    )
  }
  if (registries.length > 1) {
    throw new ConfigError(
      `validateTenantRegistry: multiple schemas declared \`{ tenantRegistry: true }\` — ${registries.map((s) => s.name).join(', ')}. Exactly one registry is allowed.`,
    )
  }
  const tenantReg = registries[0]
  if (!tenantReg) throw new Error('unreachable')
  const pkField = findPrimaryKey(tenantReg)
  const expectedType = sqlTypeFor(pkField, registry)

  // Look up the live registry table.
  const row = await db.queryOne<PgColumn>(
    `SELECT data_type, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [tenantReg.name, pkField.name],
  )
  if (!row) {
    throw new ConfigError(
      `validateTenantRegistry: registry table "${tenantReg.name}" with column "${pkField.name}" was not found in the live DB. Migration not run yet?`,
    )
  }

  const observedType = canonicalizeType(row)
  if (observedType !== expectedType) {
    throw new ConfigError(
      `validateTenantRegistry: registry "${tenantReg.name}" PK column "${pkField.name}" has type "${observedType}" in the DB, but the schema declared "${expectedType}". The DB was migrated against a different schema — re-emit the migration or fix the declaration.`,
    )
  }
}

/**
 * Normalize the information_schema's `data_type` + `character_maximum_length`
 * into the SAME string `sqlTypeFor` returns. Postgres reports varchar as
 * `character varying` with the length separate; char(N) as `character`
 * with the length separate; bigint as `bigint`; etc. We compose the
 * canonical form so equality matches what the schema declares.
 */
function canonicalizeType(col: PgColumn): string {
  switch (col.data_type) {
    case 'character':
      return col.character_maximum_length != null ? `char(${col.character_maximum_length})` : 'char'
    case 'character varying':
      return col.character_maximum_length != null
        ? `varchar(${col.character_maximum_length})`
        : 'varchar'
    case 'timestamp with time zone':
      return 'timestamptz'
    case 'timestamp without time zone':
      return 'timestamp'
    // `bigint`, `uuid`, `integer`, `boolean`, `text`, `jsonb`, `bytea`, `numeric`
    // come back as the canonical name already.
    default:
      return col.data_type
  }
}
