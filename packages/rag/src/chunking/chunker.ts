/**
 * `createChunker(config)` — factory that returns the right chunker
 * for a `ChunkingConfig`. Apps that want a custom strategy build
 * their own `Chunker` implementation and pass it directly into
 * `rag.ingest({ chunker })` instead of going through config.
 */

import type { Chunker, ChunkingConfig } from '../types.ts'
import { FixedSizeChunker } from './fixed_size_chunker.ts'
import { RecursiveChunker } from './recursive_chunker.ts'

export function createChunker(config: ChunkingConfig): Chunker {
  switch (config.strategy) {
    case 'fixed':
      return new FixedSizeChunker(config.chunkSize, config.overlap)
    case 'recursive':
      return new RecursiveChunker(config.chunkSize, config.overlap, config.separators)
  }
}
