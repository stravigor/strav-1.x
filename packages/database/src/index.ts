// Public API of @strav/database.
//
// Foundation slice + ORM slice + DDL-emission slice: connection pool
// (Bun.SQL), schema DSL, schema registry, migration runner, Model class,
// Repository<T>, QueryBuilder, schema → DDL emitters. RLS scoping, eager
// loading, encryption-at-rest, schema-diff migration generator, repository
// hooks, pagination helpers, soft-delete integration land in follow-up
// cuts.

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
  columnDefinition,
  defaultSql,
  type EmitOptions,
  type EmittedDdl,
  emitAddColumn,
  emitCreateTable,
  emitDropColumn,
  emitDropTable,
  findPrimaryKey,
  isPrimaryKeyKind,
  sqlTypeFor,
} from './ddl/index.ts'
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
  emitUpdateById,
  hasField,
  hydrateRow,
  isModelClass,
  Model,
  type ModelClass,
  QueryBuilder,
  quoteIdent,
  Repository,
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
