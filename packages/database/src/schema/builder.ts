/**
 * `SchemaBuilder` (the `t` argument inside `defineSchema(name, archetype,
 * (t) => { ... })`) — collects field declarations into the immutable
 * `Schema` returned by `defineSchema`.
 *
 * Each `t.xxx()` returns a chainable `FieldBuilder` so modifiers can stack:
 *   `t.string('email').max(320).notNull().unique()`
 *
 * Field order is preserved in declaration order; the migration runner emits
 * columns in the same order so generated SQL is auditable.
 */

import type {
  EnumField,
  FieldBase,
  ReferenceField,
  Schema,
  SchemaField,
  SchemaRelation,
  StringField,
} from './types.ts'

class FieldBuilder<F extends SchemaField = SchemaField> {
  constructor(protected readonly field: F) {}

  /** Allow NULL. (Default: NOT NULL.) */
  nullable(): this {
    ;(this.field as FieldBase).nullable = true
    return this
  }
  /** Disallow NULL — the default; provided for clarity in DSL. */
  notNull(): this {
    ;(this.field as FieldBase).nullable = false
    return this
  }
  /** Add a UNIQUE constraint. */
  unique(): this {
    ;(this.field as FieldBase).unique = true
    return this
  }
  /** Set a default value. Accepts any literal; SQL emission is the runner's job. */
  default(value: unknown): this {
    ;(this.field as FieldBase).hasDefault = true
    ;(this.field as FieldBase).default = value
    return this
  }

  /** Internal — used by SchemaBuilder.build() to extract the final field. */
  asField(): F {
    return this.field
  }
}

class ReferenceFieldBuilder extends FieldBuilder<ReferenceField> {
  /** Set the target table by Schema or by raw table name string. */
  to(target: Schema | { name: string } | string): this {
    this.field.references = typeof target === 'string' ? target : target.name
    return this
  }
  /** ON DELETE behavior. Default is `restrict`. */
  onDelete(action: 'cascade' | 'set null' | 'restrict' | 'no action'): this {
    this.field.onDelete = action
    return this
  }
}

class StringFieldBuilder extends FieldBuilder<StringField> {
  /** Max length; default 255. */
  max(value: number): this {
    this.field.max = value
    return this
  }
}

export class SchemaBuilder {
  private readonly fields: SchemaField[] = []
  private readonly relations: SchemaRelation[] = []
  private hasSoftDeletes = false
  private hasTimestamps = false

  // ─── Identity columns ───────────────────────────────────────────────────────

  /** ULID primary key (default name `id`). */
  id(name: string = 'id'): FieldBuilder {
    return this.push({ name, kind: 'id', ...this.baseFlags() })
  }
  /** UUID variant. */
  uuid(name: string = 'id'): FieldBuilder {
    return this.push({ name, kind: 'uuid', ...this.baseFlags() })
  }
  /** Auto-increment bigint. */
  bigSerial(name: string = 'id'): FieldBuilder {
    return this.push({ name, kind: 'bigSerial', ...this.baseFlags() })
  }
  /**
   * Per-tenant auto-increment bigint.
   *
   * **Deferred — emits plain `bigint NOT NULL PRIMARY KEY` today.** The
   * trigger + per-tenant sequence + composite `(tenant_id, id)` PK that
   * make this meaningful land in a follow-up tenancy slice. Until then,
   * prefer `t.id()` (ULID) for tenanted schemas — globally unique by
   * construction, no per-tenant plumbing required.
   *
   * Named `tenantedBigSerial` (not `tenantedSerial`) to mirror
   * `bigSerial` and make the underlying width explicit. Strav doesn't
   * ship a 32-bit `serial` — bigint-by-default avoids the painful
   * mid-life overflow migration that 32-bit serial PKs eventually
   * force.
   */
  tenantedBigSerial(name: string = 'id'): FieldBuilder {
    return this.push({ name, kind: 'tenantedBigSerial', ...this.baseFlags() })
  }

  // ─── Scalar columns ────────────────────────────────────────────────────────

  string(name: string): StringFieldBuilder {
    const field: StringField = {
      ...this.baseFlags(),
      name,
      kind: 'string',
      max: 255,
    }
    this.fields.push(field)
    return new StringFieldBuilder(field)
  }
  text(name: string): FieldBuilder {
    return this.push({ name, kind: 'text', ...this.baseFlags() })
  }
  integer(name: string): FieldBuilder {
    return this.push({ name, kind: 'integer', ...this.baseFlags() })
  }
  boolean(name: string): FieldBuilder {
    return this.push({ name, kind: 'boolean', ...this.baseFlags() })
  }
  decimal(name: string, precision: number, scale: number): FieldBuilder {
    const field = {
      ...this.baseFlags(),
      name,
      kind: 'decimal' as const,
      precision,
      scale,
    }
    this.fields.push(field)
    return new FieldBuilder(field)
  }
  json<_T = unknown>(name: string): FieldBuilder {
    return this.push({ name, kind: 'json', ...this.baseFlags() })
  }
  timestamp(name: string, options: { withTimezone?: boolean } = {}): FieldBuilder {
    const field = {
      ...this.baseFlags(),
      name,
      kind: 'timestamp' as const,
      withTimezone: options.withTimezone ?? true,
    }
    this.fields.push(field)
    return new FieldBuilder(field)
  }
  enum(name: string, values: readonly string[]): FieldBuilder {
    if (values.length === 0) {
      throw new Error(`SchemaBuilder.enum("${name}"): values must not be empty.`)
    }
    const field: EnumField = {
      ...this.baseFlags(),
      name,
      kind: 'enum',
      values: [...values],
    }
    this.fields.push(field)
    return new FieldBuilder(field)
  }
  reference(name: string): ReferenceFieldBuilder {
    const field: ReferenceField = {
      ...this.baseFlags(),
      name,
      kind: 'reference',
      references: '', // .to(...) sets this
      onDelete: 'restrict',
    }
    this.fields.push(field)
    return new ReferenceFieldBuilder(field)
  }
  encrypted(name: string): FieldBuilder {
    return this.push({ name, kind: 'encrypted', ...this.baseFlags() })
  }

  // ─── Composite helpers ─────────────────────────────────────────────────────

  /** Add `created_at` + `updated_at` (both `timestamptz NOT NULL DEFAULT now()`). */
  timestamps(): this {
    if (this.hasTimestamps) return this
    this.hasTimestamps = true
    for (const name of ['created_at', 'updated_at']) {
      this.fields.push({
        ...this.baseFlags(),
        name,
        kind: 'timestamp',
        withTimezone: true,
        hasDefault: true,
        default: { sql: 'now()' },
      })
    }
    return this
  }

  /** Add `deleted_at timestamptz NULL` for soft deletes. */
  softDeletes(): this {
    if (this.hasSoftDeletes) return this
    this.hasSoftDeletes = true
    this.fields.push({
      ...this.baseFlags(),
      name: 'deleted_at',
      kind: 'timestamp',
      withTimezone: true,
      nullable: true,
    })
    return this
  }

  // ─── Relations ─────────────────────────────────────────────────────────────

  /**
   * One-to-many relation. Parent has many child rows; the child carries a
   * `foreignKey` column pointing back to the parent's PK.
   *
   * `target` is the child schema's name (Schema, ModelClass-like, or string).
   * `as` defaults to the target name (`hasMany('post', { foreignKey: 'user_id' })`
   * → accessor `post` on the parent). Apps usually override to the plural:
   * `as: 'posts'`.
   */
  hasMany(
    target: Schema | { name: string } | string,
    options: { foreignKey: string; as?: string },
  ): this {
    const targetName = typeof target === 'string' ? target : target.name
    this.relations.push({
      kind: 'hasMany',
      name: options.as ?? targetName,
      target: targetName,
      foreignKey: options.foreignKey,
    })
    return this
  }

  /**
   * Inverse-of-hasMany. THIS row carries the `foreignKey` column pointing
   * at the target row's PK. Typically paired with a `t.reference(...)` for
   * the column itself — `belongsTo` only declares the relation, not the
   * column.
   */
  belongsTo(
    target: Schema | { name: string } | string,
    options: { foreignKey: string; as?: string },
  ): this {
    const targetName = typeof target === 'string' ? target : target.name
    this.relations.push({
      kind: 'belongsTo',
      name: options.as ?? targetName,
      target: targetName,
      foreignKey: options.foreignKey,
    })
    return this
  }

  /** Internal — used by `defineSchema()` to finalize. */
  build(): readonly SchemaField[] {
    return this.fields
  }

  /** Internal — finalize relation declarations. */
  buildRelations(): readonly SchemaRelation[] {
    return this.relations
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private baseFlags(): Pick<FieldBase, 'nullable' | 'unique' | 'hasDefault' | 'default' | 'order'> {
    return {
      nullable: false,
      unique: false,
      hasDefault: false,
      default: undefined,
      order: this.fields.length,
    }
  }

  private push<F extends SchemaField>(
    partial: Omit<F, 'order'> & { order?: number },
  ): FieldBuilder<F> {
    const field: F = { ...partial, order: this.fields.length } as F
    this.fields.push(field)
    return new FieldBuilder(field)
  }
}
