// Fixture for SchemaRegistry.discover() — a second schema file. Tests that
// `discover()` picks up multiple files in one pass and that schemas can
// reference each other across files (post.author_id → user.id).

import { Archetype, defineSchema } from '../../../src/index.ts'
import { userSchema } from './user_schema.ts'

export const postSchema = defineSchema('post_fixture', Archetype.Entity, (t) => {
  t.id()
  t.string('title').max(255)
  t.reference('author_id').to(userSchema)
  t.timestamps()
})
