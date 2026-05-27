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
  /** Per-tenant sequence — id type comes from the tenant registry schema. */
  tenantedSerial(name: string = 'id'): FieldBuilder {
    return this.push({ name, kind: 'tenantedSerial', ...this.baseFlags() })
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

  /** Internal — used by `defineSchema()` to finalize. */
  build(): readonly SchemaField[] {
    return this.fields
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
