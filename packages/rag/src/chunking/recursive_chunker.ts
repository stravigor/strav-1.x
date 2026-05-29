/**
 * `RecursiveChunker` — splits on paragraph / sentence / word
 * boundaries before falling back to fixed-size cuts. Better for
 * prose and Markdown content than `FixedSizeChunker` because
 * semantic boundaries survive.
 *
 * Strategy:
 *
 *   1. If the text fits in one chunk, return it whole.
 *   2. Otherwise split on the first separator that produces
 *      pieces small enough to fit (defaults: paragraph → line →
 *      sentence → word).
 *   3. Merge adjacent pieces greedily up to `chunkSize`.
 *   4. Compute `startOffset` / `endOffset` by walking the merged
 *      pieces against the original content.
 *   5. Apply a sliding overlap pass at the end so consecutive
 *      chunks share `overlap` characters of context — important
 *      for retrieval recall around chunk boundaries.
 *
 * Offsets are byte-accurate against the original content so apps
 * that highlight retrieved passages in the source can slice
 * directly with `content.slice(chunk.startOffset, chunk.endOffset)`.
 */

import type { Chunk, Chunker } from '../types.ts'

const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' '] as const

export class RecursiveChunker implements Chunker {
  private readonly separators: readonly string[]

  constructor(
    private readonly chunkSize: number = 512,
    private readonly overlap: number = 64,
    separators?: readonly string[],
  ) {
    if (chunkSize <= 0) throw new RangeError('RecursiveChunker: chunkSize must be > 0.')
    if (overlap < 0 || overlap >= chunkSize) {
      throw new RangeError('RecursiveChunker: overlap must satisfy 0 <= overlap < chunkSize.')
    }
    this.separators = separators ?? DEFAULT_SEPARATORS
  }

  chunk(content: string): Chunk[] {
    if (!content) return []
    const pieces = this.splitRecursive(content, 0)
    return this.buildChunks(content, pieces)
  }

  /**
   * Recursive split. At each separator level, split the text and
   * try to merge adjacent pieces back together greedily without
   * exceeding `chunkSize`. Pieces that don't fit at this level
   * recurse one separator deeper.
   */
  private splitRecursive(text: string, separatorIndex: number): string[] {
    if (text.length <= this.chunkSize) return [text]

    const separator = this.separators[separatorIndex]
    if (!separator) {
      // Out of separators — hard-cut to `chunkSize`.
      const out: string[] = []
      for (let i = 0; i < text.length; i += this.chunkSize) {
        out.push(text.slice(i, i + this.chunkSize))
      }
      return out
    }

    const parts = text.split(separator)
    const merged: string[] = []
    let current = ''
    for (const part of parts) {
      const candidate = current ? current + separator + part : part
      if (candidate.length <= this.chunkSize) {
        current = candidate
      } else {
        if (current) merged.push(current)
        if (part.length > this.chunkSize) {
          merged.push(...this.splitRecursive(part, separatorIndex + 1))
          current = ''
        } else {
          current = part
        }
      }
    }
    if (current) merged.push(current)
    return merged
  }

  /**
   * Map merged pieces back onto offsets in the original content,
   * then apply a sliding overlap so adjacent chunks share
   * `overlap` characters of trailing context.
   */
  private buildChunks(content: string, pieces: readonly string[]): Chunk[] {
    if (pieces.length === 0) return []

    // Walk the original content looking for each piece. The piece
    // contents are substrings of the source; `indexOf(piece, cursor)`
    // is sufficient because the recursive split preserves textual
    // order.
    const rawSpans: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (const piece of pieces) {
      const start = content.indexOf(piece, cursor)
      if (start === -1) {
        // Should never happen — splitRecursive only emits substrings —
        // but guard against pathological input by falling back to
        // appending at the cursor with the piece's literal length.
        rawSpans.push({ start: cursor, end: cursor + piece.length })
        cursor += piece.length
        continue
      }
      const end = start + piece.length
      rawSpans.push({ start, end })
      cursor = end
    }

    if (this.overlap === 0) {
      return rawSpans.map((s, i) => ({
        content: content.slice(s.start, s.end),
        index: i,
        startOffset: s.start,
        endOffset: s.end,
      }))
    }

    // Apply trailing overlap: each chunk after the first extends
    // backward by `overlap` characters into the previous span so
    // boundary context is duplicated.
    const out: Chunk[] = []
    for (let i = 0; i < rawSpans.length; i++) {
      const span = rawSpans[i]!
      const start = i === 0 ? span.start : Math.max(0, span.start - this.overlap)
      out.push({
        content: content.slice(start, span.end),
        index: i,
        startOffset: start,
        endOffset: span.end,
      })
    }
    return out
  }
}
