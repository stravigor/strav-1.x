// Schema-diff subsystem — read live DB + registered Schemas → migration ops.

export { type DiffOperation, type DiffResult, diffSchemas } from './diff.ts'
export {
  type GeneratedMigration,
  type GenerateMigrationOptions,
  generateMigration,
} from './generate.ts'
export { type ColumnInfo, type DbSnapshot, inspectDatabase, type TableInfo } from './inspect.ts'
