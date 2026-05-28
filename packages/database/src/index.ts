// Public API of @strav/database.
//
// Foundation + ORM + DDL emission + schema-diff generator: connection pool
// (Bun.SQL), schema DSL, schema registry, migration runner, Model class,
// Repository<T>, QueryBuilder, schema → DDL emitters, and a diff engine
// that produces additive migrations from registry vs live-DB state.
// RLS scoping, eager loading, encryption-at-rest, repository hooks,
// pagination helpers, soft-delete integration, destructive-diff handling
// (drops / type changes / renames) land in follow-up cuts.

export {
  type Database,
  type DatabaseExecutor,
  PostgresDatabase,
  type PostgresDatabaseOptions,
} from './database.ts'
export {
  DATABASE_KEY,
  type DatabaseConfigShape,
  DatabaseProvider,
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
  findPrimaryKey,
  isPrimaryKeyKind,
  sqlTypeFor,
  tenantIdColumnName,
  tenantRegistrySchema,
} from './ddl/index.ts'
export {
  type ColumnInfo,
  type DbSnapshot,
  type DiffOperation,
  type DiffResult,
  diffSchemas,
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
} from './migrations/index.ts'
export {
  type BuiltQuery,
  type EmittedSql,
  emitDeleteById,
  emitFindById,
  emitFindMany,
  emitInsert,
  emitRestoreById,
  emitSoftDeleteById,
  emitUpdateById,
  hasField,
  hydrateRow,
  isModelClass,
  Model,
  type ModelClass,
  QueryBuilder,
  quoteIdent,
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
  type SchemaTenancy,
  type StringField,
  type TenantedSerialField,
  type TextField,
  type TimestampField,
  type UuidField,
} from './schema/index.ts'
export { SchemaRegistry } from './schema_registry.ts'
export { TenantManager } from './tenancy/index.ts'
export {
  currentTransactionalContext,
  type QueuedEvent,
  type TransactionalContext,
  UnitOfWork,
} from './unit_of_work/index.ts'
