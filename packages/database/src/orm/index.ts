// ORM subsystem — Model, Repository, QueryBuilder, SQL emitter.

export {
  applyCastsToDb,
  applyDecryptToRow,
  applyEncryptToAttrs,
  applyUlidsToAttrs,
  CAST_FIELDS,
  cast,
  castFor,
  castsFor,
  ENCRYPT_FIELDS,
  encrypt,
  encryptedFieldsOf,
  type FieldCaster,
  HIDDEN_FIELDS,
  hidden,
  hiddenFieldsOf,
  ULID_FIELDS,
  ulid,
  ulidFieldsOf,
} from './decorators.ts'
export { hydrateRow, isModelClass, Model, type ModelClass } from './model.ts'
export {
  type BuiltQuery,
  type CursorPaginatedResult,
  type CursorPaginateOptions,
  type PaginatedResult,
  QueryBuilder,
  type RawSqlBody,
  type WhereOperator,
} from './query_builder.ts'
export {
  Repository,
  type RepositoryCreatedEvent,
  type RepositoryCreatingEvent,
  type RepositoryDeletedEvent,
  type RepositoryDeletingEvent,
  type RepositoryOptions,
  type RepositoryRestoredEvent,
  type RepositoryRestoringEvent,
  type RepositoryScope,
  type RepositoryUpdatedEvent,
  type RepositoryUpdatingEvent,
} from './repository.ts'
export {
  type EmittedSql,
  emitDeleteById,
  emitFindById,
  emitFindMany,
  emitInsert,
  emitRestoreById,
  emitSoftDeleteById,
  emitUpdateById,
  hasField,
  quoteIdent,
  schemaHasSoftDelete,
  selectColumnList,
} from './sql_emitter.ts'
