/**
 * Backward-compat re-export. The implementations live in
 * `@strav/testing/postgres` — this file exists so the dozens of
 * integration / e2e tests that already import from here keep
 * working.
 *
 * New code should import from `@strav/testing` directly.
 */

export {
  connectedRoleBypassesRls,
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
  testDatabaseUrl,
} from '@strav/testing'
