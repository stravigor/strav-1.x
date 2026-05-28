// Fixture for SchemaRegistry.discover() — a file that exports things that
// AREN'T schemas. Proves the isSchema type-guard rejects non-Schema exports
// silently (no error, just skipped).

export const someConstant = 42
export function someHelper(): string {
  return 'not a schema'
}
export const looksAlmostLikeASchema = {
  name: 'fake',
  // missing archetype / fields / tenancy / relations — should be rejected.
}
