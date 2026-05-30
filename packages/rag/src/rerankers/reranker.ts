/**
 * Re-ranking — reorder a `topK` set of retrieved documents using
 * a signal richer than raw vector similarity.
 *
 * The vector store hands back matches sorted by cosine similarity.
 * That's a strong baseline but loses information: keyword overlap,
 * diversity, recency, source authority, second-stage cross-encoder
 * scores, etc. A `Reranker` consumes the initial top-K and returns
 * the same documents in a (possibly different) order with new
 * `score` values. The raw vector `similarity` field is preserved
 * verbatim so apps that want to display both can.
 *
 * Common usage:
 *
 * ```ts
 * const { matches } = await rag.retrieve(query, {
 *   topK: 5,
 *   rerankPool: 25,                  // fetch a wider pool…
 *   rerank: new MMRReranker({ ... }),// reorder for diversity…
 * })                                  // …then slice to topK.
 * ```
 *
 * The contract is intentionally narrow: the reranker decides the
 * order. The framework handles the over-fetch-then-truncate pattern
 * via `rerankPool` so apps don't have to manage it.
 */

import type { RetrievedDocument } from '../types.ts'

export interface Reranker {
  rerank(
    query: string,
    matches: readonly RetrievedDocument[],
  ): Promise<RetrievedDocument[]> | RetrievedDocument[]
}
