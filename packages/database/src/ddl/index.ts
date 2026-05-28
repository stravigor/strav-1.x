// DDL emission subsystem — schema → CREATE TABLE / ALTER TABLE SQL.

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
} from './emit.ts'
export { findPrimaryKey, isPrimaryKeyKind, sqlTypeFor } from './sql_type.ts'
export {
  emitRlsForTenanted,
  emitTenantedBigSerialSetup,
  tenantIdColumnName,
  tenantRegistrySchema,
} from './tenancy.ts'
