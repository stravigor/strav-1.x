/**
 * `RagError` hierarchy — typed wrappers for failures in the RAG
 * stack. Each subclass carries a specific error code so apps can
 * branch on the failure mode at the call site instead of parsing
 * error messages.
 *
 * Three concrete subclasses ship in V1:
 *
 *   - `CollectionNotFoundError` — `rag.retrieve` against a
 *     collection that doesn't exist on the active store. Apps
 *     create the collection via `rag.createCollection(...)`
 *     before the first ingest.
 *
 *   - `VectorQueryError` — the underlying store rejected the
 *     query (bad dimension, malformed filter, etc.). Cause
 *     carries the driver-native error.
 *
 *   - `EmbeddingError` — the brain provider rejected the
 *     embedding call. Wraps the brain-side error so apps can
 *     `error.cause instanceof BrainError` for retry logic.
 */

import { StravError } from '@strav/kernel'

export class RagError extends StravError {
  constructor(
    message: string,
    options: {
      code?: string
      status?: number
      context?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(
      message,
      { code: options.code ?? 'rag.error', status: options.status ?? 500 },
      { ...(options.context ? { context: options.context } : {}), ...(options.cause !== undefined ? { cause: options.cause } : {}) },
    )
  }
}

export class CollectionNotFoundError extends RagError {
  constructor(collection: string, store: string) {
    super(
      `RAG collection "${collection}" does not exist on store "${store}". Call \`rag.createCollection("${collection}", dim)\` before the first ingest.`,
      {
        code: 'rag.collection_not_found',
        status: 404,
        context: { collection, store },
      },
    )
  }
}

export class VectorQueryError extends RagError {
  constructor(message: string, options: { context?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, {
      code: 'rag.vector_query',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

export class EmbeddingError extends RagError {
  constructor(message: string, options: { context?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, {
      code: 'rag.embedding',
      status: 500,
      ...(options.context ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}
