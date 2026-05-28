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
  | 'tenantedBigSerial'
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
export interface TenantedBigSerialField extends FieldBase {
  kind: 'tenantedBigSerial'
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
  | TenantedBigSerialField
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

/**
 * A relationship declaration on a schema. Drives `QueryBuilder.with(...)`
 * eager loading; doesn't affect DDL emission (FK columns are declared
 * separately via `t.reference(...)`).
 *
 * V1 supports `hasMany` (one-to-many — parent has many children whose
 * `foreignKey` column points back) and `belongsTo` (the inverse —
 * the row owns a single related row identified by a local
 * `foreignKey` column). `hasOne` + `belongsToMany` are follow-up
 * slices.
 */
export type SchemaRelation =
  | {
      kind: 'hasMany'
      /** Accessor name on the parent row (e.g. `posts` on a user). */
      name: string
      /** Target schema name (the child table, e.g. `'post'`). */
      target: string
      /** Column on the CHILD that points back to the parent's PK. */
      foreignKey: string
    }
  | {
      kind: 'belongsTo'
      /** Accessor name on this row (e.g. `author` on a post). */
      name: string
      /** Target schema name (the parent table, e.g. `'user'`). */
      target: string
      /** Column on THIS row holding the parent's PK. */
      foreignKey: string
    }

/** Compiled schema returned from `defineSchema()`. */
export interface Schema {
  /** Snake-case singular name (matches the DB table 1:1). */
  readonly name: string
  readonly archetype: Archetype
  readonly fields: readonly SchemaField[]
  readonly tenancy: SchemaTenancy
  /** Declared relations to other schemas; drives `QueryBuilder.with(...)`. */
  readonly relations: readonly SchemaRelation[]
}
