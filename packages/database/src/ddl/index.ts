// DDL emission subsystem — schema → CREATE TABLE / ALTER TABLE SQL.

export {
  columnDefinition,
  defaultSql,
  type EmitOptions,
  type EmittedDdl,
  emitAddColumn,
  emitCreateTable,
  emitDropColumn,
  emitDropTable,
} from './emit.ts'
export { findPrimaryKey, isPrimaryKeyKind, sqlTypeFor } from './sql_type.ts'
