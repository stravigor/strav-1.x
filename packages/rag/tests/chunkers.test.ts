/**
 * Chunker unit tests. Verifies offset accuracy + overlap semantics
 * + edge cases. Both chunkers are pure functions of string input;
 * no mocks needed.
 */

import { describe, expect, test } from 'bun:test'
import { createChunker } from '../src/chunking/chunker.ts'
import { FixedSizeChunker } from '../src/chunking/fixed_size_chunker.ts'
import { RecursiveChunker } from '../src/chunking/recursive_chunker.ts'

// ─── FixedSizeChunker ───────────────────────────────────────────────────

describe('FixedSizeChunker', () => {
  test('empty input → no chunks', () => {
    expect(new FixedSizeChunker(10, 0).chunk('')).toEqual([])
  })

  test('input shorter than chunkSize → single chunk', () => {
    const out = new FixedSizeChunker(100, 0).chunk('hello')
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      content: 'hello',
      index: 0,
      startOffset: 0,
      endOffset: 5,
    })
  })

  test('no overlap → adjacent windows', () => {
    const out = new FixedSizeChunker(3, 0).chunk('abcdefghi')
    expect(out.map((c) => c.content)).toEqual(['abc', 'def', 'ghi'])
    expect(out.map((c) => c.startOffset)).toEqual([0, 3, 6])
    expect(out.map((c) => c.endOffset)).toEqual([3, 6, 9])
  })

  test('overlap of 1 → windows share trailing/leading char', () => {
    const out = new FixedSizeChunker(3, 1).chunk('abcdefg')
    expect(out.map((c) => c.content)).toEqual(['abc', 'cde', 'efg'])
  })

  test('rejects invalid params', () => {
    expect(() => new FixedSizeChunker(0)).toThrow(RangeError)
    expect(() => new FixedSizeChunker(10, 10)).toThrow(RangeError)
    expect(() => new FixedSizeChunker(10, -1)).toThrow(RangeError)
  })
})

// ─── RecursiveChunker ───────────────────────────────────────────────────

describe('RecursiveChunker', () => {
  test('empty input → no chunks', () => {
    expect(new RecursiveChunker(50, 0).chunk('')).toEqual([])
  })

  test('input shorter than chunkSize → single chunk', () => {
    const out = new RecursiveChunker(100, 0).chunk('one short line')
    expect(out).toHaveLength(1)
    expect(out[0]?.content).toBe('one short line')
  })

  test('splits on paragraph boundaries first, greedily merging short adjacent paragraphs', () => {
    const input = 'first paragraph.\n\nsecond paragraph.\n\nthird.'
    const out = new RecursiveChunker(25, 0).chunk(input)
    // chunkSize is 25 chars. "first paragraph." (16) + "\n\n" + "second paragraph." (17) = 35 > 25,
    // so they split. "second paragraph." + "\n\n" + "third." (6) = 25, exactly fits → merged.
    expect(out.map((c) => c.content)).toEqual(['first paragraph.', 'second paragraph.\n\nthird.'])
  })

  test('falls through separator levels when paragraphs are too big', () => {
    // No paragraph break — chunker falls back to sentence boundary `. `.
    const input = 'sentence one. sentence two. sentence three. sentence four.'
    const out = new RecursiveChunker(20, 0).chunk(input)
    // Each sentence is ≤ 20 chars; chunker should group them.
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const chunk of out) {
      expect(chunk.content.length).toBeLessThanOrEqual(20)
    }
  })

  test('offsets reconstruct the original content when joined', () => {
    const input = 'aaaa.\n\nbbbb.\n\ncccc.\n\ndddd.'
    const out = new RecursiveChunker(8, 0).chunk(input)
    // Each chunk's content must match input.slice(startOffset, endOffset).
    for (const chunk of out) {
      expect(input.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.content)
    }
  })

  test('overlap extends each chunk backward by `overlap` chars (except the first)', () => {
    const input = 'paragraph_a.\n\nparagraph_b.\n\nparagraph_c.'
    const out = new RecursiveChunker(15, 5).chunk(input)
    expect(out.length).toBeGreaterThanOrEqual(2)
    // Second chunk's startOffset must be `overlap` chars before its
    // raw span — verify it overlaps the first chunk's tail.
    const first = out[0]!
    const second = out[1]!
    expect(second.startOffset).toBeLessThan(first.endOffset)
  })

  test('rejects invalid params', () => {
    expect(() => new RecursiveChunker(0)).toThrow(RangeError)
    expect(() => new RecursiveChunker(10, 10)).toThrow(RangeError)
  })

  test('custom separators take priority', () => {
    const out = new RecursiveChunker(8, 0, ['|']).chunk('aaaa|bbbb|cccc')
    expect(out.map((c) => c.content)).toEqual(['aaaa', 'bbbb', 'cccc'])
  })
})

// ─── createChunker factory ──────────────────────────────────────────────

describe('createChunker', () => {
  test('strategy: "fixed" returns a FixedSizeChunker', () => {
    const c = createChunker({ strategy: 'fixed', chunkSize: 10, overlap: 0 })
    expect(c).toBeInstanceOf(FixedSizeChunker)
  })

  test('strategy: "recursive" returns a RecursiveChunker', () => {
    const c = createChunker({ strategy: 'recursive', chunkSize: 10, overlap: 0 })
    expect(c).toBeInstanceOf(RecursiveChunker)
  })
})
