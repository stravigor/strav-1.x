// Public API of @strav/database.
//
// Connection pool (Bun.SQL), schema DSL + registry, migration runner,
// Model class with @hidden / @cast / @ulid / @encrypt decorators,
// Repository<T> with lifecycle events + soft-delete + eager loading,
// QueryBuilder (where / orderBy / limit / offset / .with / .paginate),
// schema → DDL emitters + RLS policy emission, schema-diff engine
// (additive + destructive) producing migrations from registry vs
// live-DB state, multi-tenancy (TenantManager.withTenant /
// withoutTenant / withTenantLock / withLock built on UnitOfWork),
// boot-time tenant-registry validation.
//
// Still deferred (each is its own follow-up cut):
//   - QueryBuilder joins / CTEs / cursor pagination / .chunk()
//   - tenantedBigSerial per-tenant sequence + trigger + composite PK
//   - generateMigration tenancy awareness (RLS + tenant-FK churn)
//   - generateMigration default-value drift detection
//   - Two-role (BYPASSRLS / NOBYPASSRLS) connection config
//   - Console commands (db:migrate, make:migration, …) — needs @strav/cli
//   - Relations: typed children, nested loads, hasOne, belongsToMany, lazy
//   - Encryption key rotation, blind-index helpers, per-tenant keys

export {
  DatabaseConsoleProvider,
  DbSeed,
  Migrate,
  MigrateFresh,
  MigrateGenerate,
  MigrateRollback,
  MigrateStatus,
} from './console/index.ts'
export {
  AdminDatabase,
  type Database,
  type DatabaseExecutor,
  PostgresDatabase,
  type PostgresDatabaseOptions,
} from './database.ts'
export {
  ADMIN_DATABASE_KEY,
  DATABASE_KEY,
  type DatabaseConfigShape,
  DatabaseProvider,
  DEFAULT_MIGRATIONS_PATH,
} from './database_provider.ts'
export {
  type CreateIndexOptions,
  columnDefinition,
  defaultSql,
  type EmitOptions,
  type EmittedDdl,
  emitAddColumn,
  emitCreateIndex,
  emitCreateTable,
  emitDropColumn,
  emitDropIndex,
  emitDropTable,
  emitRenameColumn,
  emitRenameTable,
  emitRlsForTenanted,
  emitTenantedBigSerialSetup,
  findPrimaryKey,
  isPrimaryKeyKind,
  sqlTypeFor,
  tenantIdColumnName,
  tenantRegistrySchema,
} from './ddl/index.ts'
export {
  type AlterColumnState,
  type ColumnInfo,
  type DbSnapshot,
  type DiffOperation,
  type DiffOptions,
  type DiffRenames,
  type DiffResult,
  diffSchemas,
  emitAlterColumnSql,
  type GeneratedMigration,
  type GenerateMigrationOptions,
  generateMigration,
  inspectDatabase,
  type TableInfo,
} from './diff/index.ts'
export {
  type AppliedMigration,
  type Migration,
  type MigrationRollbackResult,
  MigrationRunner,
  type MigrationRunResult,
  type MigrationStatus,
  resolveMigrationRunner,
} from './migrations/index.ts'
export {
  applyCastsToDb,
  applyDecryptToRow,
  applyEncryptToAttrs,
  applyUlidsToAttrs,
  type BuiltQuery,
  CAST_FIELDS,
  type CursorPaginatedResult,
  type CursorPaginateOptions,
  cast,
  castFor,
  castsFor,
  type EmittedSql,
  ENCRYPT_FIELDS,
  emitDeleteById,
  emitFindById,
  emitFindMany,
  emitInsert,
  emitRestoreById,
  emitSoftDeleteById,
  emitUpdateById,
  encrypt,
  encryptedFieldsOf,
  type FieldCaster,
  HIDDEN_FIELDS,
  hasField,
  hidden,
  hiddenFieldsOf,
  hydrateRow,
  isModelClass,
  Model,
  type ModelClass,
  type PaginatedResult,
  QueryBuilder,
  quoteIdent,
  type RawSqlBody,
  Repository,
  type RepositoryCreatedEvent,
  type RepositoryCreatingEvent,
  type RepositoryDeletedEvent,
  type RepositoryDeletingEvent,
  type RepositoryRestoredEvent,
  type RepositoryRestoringEvent,
  type RepositoryScope,
  type RepositoryUpdatedEvent,
  type RepositoryUpdatingEvent,
  schemaHasSoftDelete,
  selectColumnList,
  ULID_FIELDS,
  ulid,
  ulidFieldsOf,
  type WhereOperator,
} from './orm/index.ts'
export {
  Archetype,
  type BigSerialField,
  type BooleanField,
  type DecimalField,
  defineSchema,
  type EncryptedField,
  type EnumField,
  type FieldBase,
  type FieldKind,
  type IdField,
  type IntegerField,
  type JsonField,
  type ReferenceField,
  type Schema,
  type SchemaField,
  type SchemaRelation,
  type SchemaTenancy,
  type StringField,
  type TenantedBigSerialField,
  type TextField,
  type TimestampField,
  type UuidField,
} from './schema/index.ts'
export { isSchema, SchemaRegistry } from './schema_registry.ts'
export {
  type DatabaseSeeder,
  type DiscoveredSeeder,
  discoverSeeders,
} from './seeders.ts'
export { emitTenantIdFunction, TenantManager, validateTenantRegistry } from './tenancy/index.ts'
export {
  currentTransactionalContext,
  type QueuedEvent,
  type TransactionalContext,
  UnitOfWork,
} from './unit_of_work/index.ts'
