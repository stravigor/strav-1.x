// Fixture for SchemaRegistry.discover() — a barrel that re-exports the same
// schema instances under different names. Proves that seeing the same Schema
// object via multiple files is deduplicated by instance identity (no
// "already registered" error from the second sighting).

export { postSchema } from './post_schema.ts'
// Same userSchema instance, re-exported under a different alias.
export { userSchema, userSchema as renamedUserSchema } from './user_schema.ts'
