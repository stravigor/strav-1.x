// Public API of @strav/database.
//
// Foundation slice: connection pool (Bun.SQL), schema DSL, schema registry,
// migration runner. Repository pattern, query builder, Model class, RLS
// scoping, eager loading, encrypted-at-rest, schema-diff migration
// generator all land in follow-up cuts.

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
  type AppliedMigration,
  type Migration,
  type MigrationRollbackResult,
  MigrationRunner,
  type MigrationRunResult,
  type MigrationStatus,
} from './migrations/index.ts'
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
