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

class ForeignKeyFieldBuilder extends FieldBuilder<ReferenceField> {
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
  /**
   * Foreign-key column WITHOUT a relation accessor on this row. Use when
   * you want the FK constraint (and `.nullable()` / `.onDelete()` control)
   * but don't need `.with('<accessor>')` to eager-load the parent — e.g.
   * audit columns like `created_by_id`, self-references on tree tables, or
   * link tables that don't need a typed parent on the join row.
   *
   * For the common case (FK column + queryable relation accessor), use
   * `t.belongsTo(target, { as: '...' })` instead — it declares both in
   * one call.
   *
   * Targets accept a Schema object (typed, cross-checked at compile time),
   * a `{ name }` object, or a raw string. Use a string when two schemas
   * cycle (`'post' ↔ 'user'` declared in separate files) — the FK type
   * resolves at DDL emission via the SchemaRegistry, not at build time,
   * so a forward string reference is safe.
   */
  foreign(name: string): ForeignKeyFieldBuilder {
    const field: ReferenceField = {
      ...this.baseFlags(),
      name,
      kind: 'reference',
      references: '', // .to(...) sets this
      onDelete: 'restrict',
    }
    this.fields.push(field)
    return new ForeignKeyFieldBuilder(field)
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
   * One-to-one relation. Like `hasMany`, but the eager-load result is
   * the single matching child row (or `null`) instead of an array.
   * Same wire shape as `hasMany` — the child carries the `foreignKey`
   * back-reference. Use for 1:1 records that live in a separate table
   * (a user's profile, a draft snapshot of a post).
   */
  hasOne(
    target: Schema | { name: string } | string,
    options: { foreignKey: string; as?: string },
  ): this {
    const targetName = typeof target === 'string' ? target : target.name
    this.relations.push({
      kind: 'hasOne',
      name: options.as ?? targetName,
      target: targetName,
      foreignKey: options.foreignKey,
    })
    return this
  }

  /**
   * Inverse-of-hasMany/hasOne. THIS row carries the FK column pointing
   * at the target row's PK; `belongsTo` declares BOTH the column AND
   * the relation in one call.
   *
   * `foreignKey` defaults to `<target>_id` (e.g., `'user_id'` for the
   * `user` target). The FK column's SQL type matches the target's PK
   * type — resolved at DDL emission, not at schema-build time.
   *
   * If a field with the resolved `foreignKey` name already exists on
   * this schema (e.g., the app declared the column via `t.foreign(...)`
   * explicitly because it needs flags `belongsTo` doesn't expose),
   * `belongsTo` skips column creation and just declares the relation —
   * the existing column wins. Lets `t.foreign(...)` + `t.belongsTo(...)`
   * compose when needed.
   *
   * Use `t.foreign(name).to(target)` directly for FK columns that
   * don't need a relation (e.g., audit-log "created_by_id" where you
   * don't want a parent accessor on the row).
   */
  belongsTo(
    target: Schema | { name: string } | string,
    options: {
      foreignKey?: string
      as?: string
      nullable?: boolean
      onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action'
    } = {},
  ): this {
    const targetName = typeof target === 'string' ? target : target.name
    const foreignKey = options.foreignKey ?? `${targetName}_id`

    // Auto-create the FK column if the app hasn't already declared one.
    // Detection is by field name — same logic the registry uses to find
    // a column. Existing `t.foreign(...)` declarations are honored as-is.
    const existing = this.fields.find((f) => f.name === foreignKey)
    if (!existing) {
      const field: ReferenceField = {
        ...this.baseFlags(),
        name: foreignKey,
        kind: 'reference',
        references: targetName,
        onDelete: options.onDelete ?? 'restrict',
      }
      if (options.nullable) field.nullable = true
      this.fields.push(field)
    }

    this.relations.push({
      kind: 'belongsTo',
      name: options.as ?? targetName,
      target: targetName,
      foreignKey,
    })
    return this
  }

  /**
   * Many-to-many relation through a pivot table. The pivot row carries
   * `parentKey` (FK to this entity's PK) and `targetKey` (FK to the
   * target's PK). Eager-loaded children come back as an array, deduped
   * by target PK.
   *
   * The pivot table + its columns are declared with a separate
   * `defineSchema(pivot, ...)` — `belongsToMany` only declares the
   * relation. Apps name the pivot however they like (`'user_role'`,
   * `'tag_post'`); the convention is `<a>_<b>` alphabetised.
   */
  belongsToMany(
    target: Schema | { name: string } | string,
    options: {
      pivot: string
      parentKey: string
      targetKey: string
      as?: string
    },
  ): this {
    const targetName = typeof target === 'string' ? target : target.name
    this.relations.push({
      kind: 'belongsToMany',
      name: options.as ?? targetName,
      target: targetName,
      pivot: options.pivot,
      parentKey: options.parentKey,
      targetKey: options.targetKey,
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
