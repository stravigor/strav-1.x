/**
 * `FixedSizeChunker` — mechanical character-window chunking.
 *
 * Walks the content with a fixed window of `chunkSize` characters
 * and steps forward by `chunkSize - overlap` each iteration. Cheap,
 * predictable, agnostic to structure — best for content where
 * paragraph / sentence boundaries don't carry meaning (logs, code
 * tokens, raw transcript text).
 *
 * Apps with prose-style content should prefer `RecursiveChunker`,
 * which respects paragraph and sentence boundaries.
 */

import type { Chunk, Chunker } from '../types.ts'

export class FixedSizeChunker implements Chunker {
  constructor(
    private readonly chunkSize: number = 512,
    private readonly overlap: number = 64,
  ) {
    if (chunkSize <= 0) throw new RangeError('FixedSizeChunker: chunkSize must be > 0.')
    if (overlap < 0 || overlap >= chunkSize) {
      throw new RangeError('FixedSizeChunker: overlap must satisfy 0 <= overlap < chunkSize.')
    }
  }

  chunk(content: string): Chunk[] {
    if (!content) return []

    const out: Chunk[] = []
    const step = this.chunkSize - this.overlap

    let start = 0
    let index = 0
    while (start < content.length) {
      const end = Math.min(start + this.chunkSize, content.length)
      out.push({
        content: content.slice(start, end),
        index,
        startOffset: start,
        endOffset: end,
      })
      index++
      start += step
      if (end === content.length) break
    }
    return out
  }
}
