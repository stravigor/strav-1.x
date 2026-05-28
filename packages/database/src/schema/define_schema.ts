/**
 * `defineSchema(name, archetype, fn, opts?)` — the single source of truth
 * for a table's shape.
 *
 * ```ts
 * export const userSchema = defineSchema('user', Archetype.Entity, (t) => {
 *   t.id()
 *   t.string('email').unique().notNull()
 *   t.string('name').notNull()
 *   t.timestamps()
 *   t.softDeletes()
 * }, { tenanted: true })
 * ```
 *
 * Returns an immutable `Schema`. The migration runner and the future
 * query-builder + repository layers consume it.
 */

import { SchemaBuilder } from './builder.ts'
import type { Archetype, Schema, SchemaTenancy } from './types.ts'

export function defineSchema(
  name: string,
  archetype: Archetype,
  build: (t: SchemaBuilder) => void,
  options: SchemaTenancy = {},
): Schema {
  if (!isValidSchemaName(name)) {
    throw new Error(
      `defineSchema: "${name}" is not a valid schema name. Use snake_case singular (matches the DB table 1:1).`,
    )
  }
  if (options.tenantRegistry && options.tenanted) {
    throw new Error(
      `defineSchema("${name}"): tenantRegistry and tenanted are mutually exclusive. ` +
        "A registry table can't itself be tenant-scoped.",
    )
  }

  const builder = new SchemaBuilder()
  build(builder)
  const fields = builder.build()
  const relations = builder.buildRelations()

  return Object.freeze({
    name,
    archetype,
    fields,
    tenancy: Object.freeze({ ...options }),
    relations,
  })
}

/**
 * Snake-case singular: lowercase letters, digits, underscores. Must start
 * with a letter. Singular-ness isn't enforced — the framework doesn't
 * pluralize, so `users` would just mean the table is named `users`.
 */
function isValidSchemaName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}
