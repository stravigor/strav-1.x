// Public API of @strav/testing.
//
// V1 ships the small utilities that get re-implemented inline in every
// test: an in-memory writable stream, a typed fetch stub, and the
// Postgres availability + reset helpers used by integration suites.
// V2 (this slice) adds bootTestApp + composeTestConfig +
// TenantManagerProvider for the e2e boot-dance.

export {
  bootTestApp,
  type BootTestAppOptions,
  type BootTestAppResult,
  type TestMigration,
} from './boot_test_app.ts'
export { composeTestConfig, type ConfigOverrides } from './compose_test_config.ts'
export { MemStream } from './mem_stream.ts'
export { stubFetch, type FetchHandler } from './stub_fetch.ts'
export { TenantManagerProvider } from './tenant_manager_provider.ts'

// Postgres helpers — also re-exported under `@strav/testing/postgres`
// for apps that want to import them without pulling in the rest of
// the barrel.
export {
  connectedRoleBypassesRls,
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
  testDatabaseUrl,
} from './postgres/index.ts'
