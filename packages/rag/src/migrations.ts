/**
 * Migration helpers — emit the DDL apps need to put `rag_vector`
 * into a working state. The framework's `emitCreateTable` handles
 * everything except the pgvector-specific bits (the `vector(N)`
 * column type and the HNSW index). This module fills the gap.
 *
 * Apps drop one call into their migration:
 *
 * ```ts
 * import { SchemaRegistry, emitDropTable, type Migration } from '@strav/database'
 * import { applyRagVectorMigration, ragVectorSchema } from '@strav/rag'
 *
 * export const migration: Migration = {
 *   name: '20260601000000_create_rag_vector',
 *   async up(db) {
 *     await applyRagVectorMigration(db, {
 *       dimension: 1536,           // match the embedding model
 *       registry,
 *     })
 *   },
 *   async down(db) {
 *     await db.execute(emitDropTable(ragVectorSchema.name).sql)
 *   },
 * }
 * ```
 *
 * The helper is idempotent against `IF NOT EXISTS` clauses where
 * Postgres supports them, but apps should still rely on the
 * migration runner's tracking table for re-run safety rather than
 * the helper itself.
 */

import {
  emitCreateTable,
  type DatabaseExecutor,
  type SchemaRegistry,
} from '@strav/database'
import { ragVectorSchema } from './rag_vector_schema.ts'

export interface ApplyRagVectorMigrationOptions {
  /**
   * Vector dimension. Must match the configured embedding model
   * (OpenAI's `text-embedding-3-small` → 1536,
   * `text-embedding-3-large` → 3072, Gemini's
   * `text-embedding-004` → 768, etc.). Mismatched dimensions
   * cause `vector` casts at INSERT to throw.
   */
  dimension: number
  /**
   * Schema registry — required for `emitCreateTable` to resolve
   * foreign-key references (the tenant registry, in this case).
   */
  registry: SchemaRegistry
  /**
   * Optional override table name. Defaults to `rag_vector` (the
   * `ragVectorSchema.name`). Apps that need multiple vector
   * tables (e.g., one per dimension) override this here AND
   * register their own schema variant under the override name.
   */
  table?: string
  /**
   * HNSW construction parameter `m`. Default Postgres-level
   * default (16). Higher = better recall, slower builds.
   */
  hnswM?: number
  /**
   * HNSW construction parameter `ef_construction`. Default 64.
   * Higher = better recall, slower builds.
   */
  hnswEfConstruction?: number
}

export async function applyRagVectorMigration(
  db: DatabaseExecutor,
  options: ApplyRagVectorMigrationOptions,
): Promise<void> {
  const table = options.table ?? ragVectorSchema.name
  const { dimension, registry } = options

  await db.execute(`CREATE EXTENSION IF NOT EXISTS vector`)

  // Framework table + RLS + tenant_id column come from emitCreateTable.
  await db.execute(emitCreateTable(ragVectorSchema, { registry }).sql)

  // Vector column — pgvector-specific. NOT NULL because every
  // ingested chunk has an embedding by construction.
  await db.execute(
    `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "embedding" vector(${dimension}) NOT NULL`,
  )

  // HNSW index on cosine ops — pgvector's default for similarity
  // search. Partial index per collection isn't possible at
  // CREATE INDEX time without a literal value; apps that have
  // very large per-collection corpora add `WHERE collection = '...'`
  // partial indexes in a separate migration.
  const hnswOpts: string[] = []
  if (options.hnswM !== undefined) hnswOpts.push(`m = ${options.hnswM}`)
  if (options.hnswEfConstruction !== undefined) {
    hnswOpts.push(`ef_construction = ${options.hnswEfConstruction}`)
  }
  const withClause = hnswOpts.length > 0 ? ` WITH (${hnswOpts.join(', ')})` : ''
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_${table}_embedding_hnsw"
     ON "${table}" USING hnsw ("embedding" vector_cosine_ops)${withClause}`,
  )

  // Helpful secondary indexes for the standard access patterns.
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_${table}_collection"
     ON "${table}" ("collection")`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS "idx_${table}_source_id"
     ON "${table}" ("source_id") WHERE "source_id" IS NOT NULL`,
  )
}
