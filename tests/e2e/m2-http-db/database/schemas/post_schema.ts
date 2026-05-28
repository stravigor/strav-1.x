import { Archetype, defineSchema } from '@strav/database'

export const postSchema = defineSchema(
  'post',
  Archetype.Entity,
  (t) => {
    t.id()
    t.string('title').max(255)
    t.string('body').max(2000)
    t.timestamps()
  },
  { tenanted: true },
)
