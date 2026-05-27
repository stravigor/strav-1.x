/**
 * Schema types — the immutable description that `defineSchema()` produces.
 *
 * `Schema` is the single source of truth: table name, fields, archetype,
 * tenancy flags. The migration runner reads it to emit SQL; future
 * query-builder + repository layers read it to know columns + types; the
 * Model layer reads it to bind decorators.
 *
 * Held in memory after `defineSchema()` returns. Apps register schemas with
 * `SchemaRegistry` (manual call today; auto-discovery via `Bun.Glob` is a
 * follow-up).
 */

export enum Archetype {
  /** Has identity, mutable, top-level resource (User, Order). */
  Entity = 'entity',
  /** Owned by another entity (UserProfile, OrderShippingAddress). */
  Attribute = 'attribute',
  /** Lookup table (Country, Currency). Cached. */
  Reference = 'reference',
  /** Append-only, immutable (LoginEvent, PaymentReceived). */
  Event = 'event',
  /** Singleton settings (SystemSettings). */
  Configuration = 'configuration',
}

export type FieldKind =
  | 'id'
  | 'uuid'
  | 'bigSerial'
  | 'tenantedSerial'
  | 'string'
  | 'text'
  | 'integer'
  | 'boolean'
  | 'decimal'
  | 'json'
  | 'timestamp'
  | 'enum'
  | 'reference'
  | 'encrypted'

/** Base shape every field shares. */
export interface FieldBase {
  name: string
  kind: FieldKind
  nullable: boolean
  unique: boolean
  hasDefault: boolean
  default: unknown
  /** Original source-order index — preserves declaration order in migrations. */
  order: number
}

export interface IdField extends FieldBase {
  kind: 'id'
}
export interface UuidField extends FieldBase {
  kind: 'uuid'
}
export interface BigSerialField extends FieldBase {
  kind: 'bigSerial'
}
export interface TenantedSerialField extends FieldBase {
  kind: 'tenantedSerial'
}
export interface StringField extends FieldBase {
  kind: 'string'
  /** Max length; default 255. */
  max: number
}
export interface TextField extends FieldBase {
  kind: 'text'
}
export interface IntegerField extends FieldBase {
  kind: 'integer'
}
export interface BooleanField extends FieldBase {
  kind: 'boolean'
}
export interface DecimalField extends FieldBase {
  kind: 'decimal'
  precision: number
  scale: number
}
export interface JsonField extends FieldBase {
  kind: 'json'
}
export interface TimestampField extends FieldBase {
  kind: 'timestamp'
  /** When true, the column is `timestamptz` (with time zone). Default true. */
  withTimezone: boolean
}
export interface EnumField extends FieldBase {
  kind: 'enum'
  values: readonly string[]
}
export interface ReferenceField extends FieldBase {
  kind: 'reference'
  /** Referenced table name (the target schema's `name`). */
  references: string
  /** `cascade | set null | restrict | no action`. Default `restrict`. */
  onDelete: 'cascade' | 'set null' | 'restrict' | 'no action'
}
export interface EncryptedField extends FieldBase {
  kind: 'encrypted'
}

export type SchemaField =
  | IdField
  | UuidField
  | BigSerialField
  | TenantedSerialField
  | StringField
  | TextField
  | IntegerField
  | BooleanField
  | DecimalField
  | JsonField
  | TimestampField
  | EnumField
  | ReferenceField
  | EncryptedField

/** Tenancy options. */
export interface SchemaTenancy {
  /** This schema IS the tenant table (typically `tenant`). Mutually exclusive with `tenanted`. */
  tenantRegistry?: boolean
  /** RLS-scoped to current tenant; a tenant FK is injected at migration time. */
  tenanted?: boolean
}

/** Compiled schema returned from `defineSchema()`. */
export interface Schema {
  /** Snake-case singular name (matches the DB table 1:1). */
  readonly name: string
  readonly archetype: Archetype
  readonly fields: readonly SchemaField[]
  readonly tenancy: SchemaTenancy
}
