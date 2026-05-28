// ORM subsystem — Model, Repository, QueryBuilder, SQL emitter.

export {
  applyCastsToDb,
  CAST_FIELDS,
  cast,
  castFor,
  castsFor,
  type FieldCaster,
  HIDDEN_FIELDS,
  hidden,
  hiddenFieldsOf,
} from './decorators.ts'
export { hydrateRow, isModelClass, Model, type ModelClass } from './model.ts'
export {
  type BuiltQuery,
  type PaginatedResult,
  QueryBuilder,
  type WhereOperator,
} from './query_builder.ts'
export {
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
