/**
 * Schema → Postgres SQL type mapping.
 *
 * The single place every DDL emitter consults to translate a `FieldKind`
 * into the column type that goes into `CREATE TABLE` / `ALTER TABLE ADD
 * COLUMN`. References resolve through the `SchemaRegistry` so the FK column
 * adopts the target table's PK type — which is how `t.reference('user_id')
 * .to(User)` ends up emitting `char(26)` (matching `User.id`) instead of
 * a guessed default.
 *
 * Why these specific choices:
 *   - `id` (ULID)        → `char(26)`. ULIDs are exactly 26 Crockford base32
 *                          chars; `char(26)` reserves the width and rejects
 *                          shorter strings at the DB layer.
 *   - `json`             → `jsonb`. Modern Postgres practice — indexable,
 *                          faster on read, no whitespace preservation we'd
 *                          ever need.
 *   - `enum`             → `text` + CHECK. Postgres native ENUM types exist,
 *                          but altering one (adding/removing/reordering
 *                          values) drops every referencing column. `text`
 *                          + CHECK is editable in place.
 *   - `encrypted`        → `bytea`. Ciphertext + nonce + tag are bytes;
 *                          `text` would force a base64 round-trip.
 *   - `tenantedBigSerial`   → `bigint`. The actual per-tenant sequencing
 *                          (trigger + sequence + RLS interaction) lands
 *                          with the tenancy slice — column type today is
 *                          just `bigint NOT NULL PRIMARY KEY`.
 */

import type {
  DecimalField,
  Schema,
  SchemaField,
  StringField,
  TimestampField,
} from '../schema/types.ts'
import type { SchemaRegistry } from '../schema_registry.ts'

/**
 * Postgres type expression for a field. Reference fields require a
 * registry so the FK column can adopt the target PK type; throwing
 * surfaces the missing wire at boot/migration time instead of producing
 * a silently-incompatible column.
 */
export function sqlTypeFor(field: SchemaField, registry?: SchemaRegistry): string {
  switch (field.kind) {
    case 'id':
      return 'char(26)'
    case 'uuid':
      return 'uuid'
    case 'bigSerial':
      return 'bigserial'
    case 'tenantedBigSerial':
      return 'bigint'
    case 'string':
      return `varchar(${(field as StringField).max})`
    case 'text':
      return 'text'
    case 'integer':
      return 'integer'
    case 'boolean':
      return 'boolean'
    case 'decimal': {
      const d = field as DecimalField
      return `numeric(${d.precision}, ${d.scale})`
    }
    case 'json':
      return 'jsonb'
    case 'timestamp':
      return (field as TimestampField).withTimezone ? 'timestamptz' : 'timestamp'
    case 'enum':
      return 'text'
    case 'encrypted':
      return 'bytea'
    case 'reference': {
      const target = resolveReferenceTarget(field.name, field.references, registry)
      return sqlTypeFor(findPrimaryKey(target), registry)
    }
  }
}

/**
 * The primary-key field of a schema — the first id/uuid/bigSerial/
 * tenantedBigSerial. Every schema MUST declare one; the framework treats
 * schemas without a PK as a programmer error (no Repository CRUD is
 * possible against an unidentified row).
 */
export function findPrimaryKey(schema: Schema): SchemaField {
  for (const f of schema.fields) {
    if (
      f.kind === 'id' ||
      f.kind === 'uuid' ||
      f.kind === 'bigSerial' ||
      f.kind === 'tenantedBigSerial'
    ) {
      return f
    }
  }
  throw new Error(
    `findPrimaryKey("${schema.name}"): no identity field found. ` +
      'Schemas must declare exactly one of t.id() / t.uuid() / t.bigSerial() / t.tenantedBigSerial().',
  )
}

/** True when `field` is a PK kind. PK implies NOT NULL + UNIQUE in Postgres. */
export function isPrimaryKeyKind(field: SchemaField): boolean {
  return (
    field.kind === 'id' ||
    field.kind === 'uuid' ||
    field.kind === 'bigSerial' ||
    field.kind === 'tenantedBigSerial'
  )
}

/** Look up the referenced schema; loud-fail when missing. Internal. */
export function resolveReferenceTarget(
  fieldName: string,
  refName: string,
  registry: SchemaRegistry | undefined,
): Schema {
  const target = registry?.get(refName)
  if (!target) {
    throw new Error(
      `Reference field "${fieldName}" → "${refName}": referenced schema not registered. ` +
        'Pass a SchemaRegistry via the DDL emit options so the FK column can adopt the target PK type.',
    )
  }
  return target
}
