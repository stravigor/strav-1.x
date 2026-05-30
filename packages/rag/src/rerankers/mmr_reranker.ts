/**
 * `MMRReranker` — Maximal Marginal Relevance.
 *
 * Reorders matches to balance relevance to the query against
 * diversity among the chosen documents. Useful when the raw top-K
 * contains near-duplicate chunks from the same source.
 *
 *     MMR(d) = λ * sim(d, query) - (1 - λ) * max_{s ∈ selected} sim(d, s)
 *
 * `λ = 1.0` collapses to pure similarity (no diversity bias);
 * `λ = 0.0` greedily maximizes diversity ignoring the query.
 * `0.5` (default) is a balanced middle.
 *
 * Requires document embeddings the vector store didn't return. The
 * caller provides an `embed(text)` callback — typically
 * `(t) => brain.embed([t]).then(r => r.embeddings[0])`. The reranker
 * embeds the query + every document once (`matches.length + 1`
 * calls); apps that rerank pools >50 should cache or pre-compute
 * upstream.
 */

import type { RetrievedDocument } from '../types.ts'
import type { Reranker } from './reranker.ts'

export interface MMRRerankerOptions {
  /**
   * Compute an embedding for a single piece of text. Apps wire
   * this from `BrainManager.embed`:
   *
   *   embed: async (t) => {
   *     const r = await brain.embed([t], { model: 'text-embedding-3-small' })
   *     return r.embeddings[0]!
   *   }
   */
  embed(text: string): Promise<number[]>
  /**
   * Relevance/diversity blend in `[0, 1]`. Default `0.5`. `1.0` =
   * pure similarity; `0.0` = pure diversity.
   */
  lambda?: number
}

export class MMRReranker implements Reranker {
  private readonly embed: (text: string) => Promise<number[]>
  private readonly lambda: number

  constructor(options: MMRRerankerOptions) {
    this.embed = options.embed
    this.lambda = options.lambda ?? 0.5
  }

  async rerank(query: string, matches: readonly RetrievedDocument[]): Promise<RetrievedDocument[]> {
    if (matches.length <= 1) return [...matches]

    const queryEmbedding = await this.embed(query)
    const docEmbeddings = await Promise.all(matches.map((m) => this.embed(m.content)))

    const remaining = matches.map((_, i) => i)
    const ordered: { index: number; mmr: number }[] = []

    while (remaining.length > 0) {
      let bestSlot = 0
      let bestMmr = Number.NEGATIVE_INFINITY
      for (let r = 0; r < remaining.length; r++) {
        const i = remaining[r] as number
        const relevance = cosineSimilarity(queryEmbedding, docEmbeddings[i] as number[])
        let maxOverlap = 0
        for (const { index: s } of ordered) {
          const overlap = cosineSimilarity(
            docEmbeddings[i] as number[],
            docEmbeddings[s] as number[],
          )
          if (overlap > maxOverlap) maxOverlap = overlap
        }
        const mmr = this.lambda * relevance - (1 - this.lambda) * maxOverlap
        if (mmr > bestMmr) {
          bestMmr = mmr
          bestSlot = r
        }
      }
      const chosen = remaining[bestSlot] as number
      ordered.push({ index: chosen, mmr: bestMmr })
      remaining.splice(bestSlot, 1)
    }

    return ordered.map(({ index, mmr }) => ({
      ...(matches[index] as RetrievedDocument),
      score: mmr,
    }))
  }
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    const ai = a[i] as number
    const bi = b[i] as number
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
