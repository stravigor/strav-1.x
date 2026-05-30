/**
 * `KeywordReranker` — boost matches whose content literally contains
 * tokens from the query.
 *
 * Useful when the embedder is too smooth for short, jargon-heavy
 * queries (product SKUs, error codes, acronyms). Combines the raw
 * vector similarity with a token-overlap score:
 *
 *     score = (1 - weight) * similarity + weight * overlap
 *
 * where `overlap = matched tokens / total query tokens`. Pure
 * lexical with no inverted index — fine at top-K sizes of a few
 * dozen. Apps that need real BM25 wire a custom `Reranker`.
 */

import type { RetrievedDocument } from '../types.ts'
import type { Reranker } from './reranker.ts'

export interface KeywordRerankerOptions {
  /**
   * Blend factor between vector similarity (0) and keyword overlap
   * (1). Default `0.3` — similarity stays the dominant signal,
   * keyword overlap nudges exact-match docs higher.
   */
  weight?: number
  /** Case-sensitive matching. Default `false`. */
  caseSensitive?: boolean
  /**
   * Custom tokenizer. Default splits on Unicode whitespace and
   * drops empty fragments. Apps with stricter requirements (stem,
   * stop-word filter, etc.) pass their own.
   */
  tokenize?(input: string): readonly string[]
}

export class KeywordReranker implements Reranker {
  private readonly weight: number
  private readonly caseSensitive: boolean
  private readonly tokenize: (input: string) => readonly string[]

  constructor(options: KeywordRerankerOptions = {}) {
    this.weight = options.weight ?? 0.3
    this.caseSensitive = options.caseSensitive ?? false
    this.tokenize = options.tokenize ?? defaultTokenize
  }

  rerank(query: string, matches: readonly RetrievedDocument[]): RetrievedDocument[] {
    const queryStr = this.caseSensitive ? query : query.toLowerCase()
    const tokens = [...new Set(this.tokenize(queryStr))].filter(Boolean)
    if (tokens.length === 0) return [...matches]

    const scored = matches.map((m) => {
      const haystack = this.caseSensitive ? m.content : m.content.toLowerCase()
      let hits = 0
      for (const token of tokens) {
        if (haystack.includes(token)) hits++
      }
      const overlap = hits / tokens.length
      const blended = m.similarity * (1 - this.weight) + overlap * this.weight
      return { ...m, score: blended }
    })

    return scored.sort((a, b) => b.score - a.score)
  }
}

function defaultTokenize(input: string): readonly string[] {
  return input.split(/\s+/)
}
