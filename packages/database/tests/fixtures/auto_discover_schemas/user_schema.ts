// Fixture for SchemaRegistry.discover() — a typical app-defined schema file.

import { Archetype, defineSchema } from '../../../src/index.ts'

export const userSchema = defineSchema('user_fixture', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
})
