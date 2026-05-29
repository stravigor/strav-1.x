/**
 * `bun strav rag:list` — print the configured RAG stores +
 * chunker + embedding setup.
 *
 * Diagnostic only — no mutations. Useful for verifying that
 * `config/rag.ts` parses correctly and that the registered
 * driver names match what's expected.
 */

import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { RagManager } from '../rag_manager.ts'

export class RagList extends Command {
  static signature = 'rag:list'
  static description = 'List configured RAG stores + embedding + chunking settings.'
  static providers = ['config', 'logger', 'brain', 'rag']

  override async execute(_args: ExecuteArgs): Promise<number> {
    const manager = this.app.resolve(RagManager)
    const config = manager.config

    this.info(`Default store: ${config.default}`)
    if (config.prefix) this.info(`Collection prefix: ${config.prefix}`)

    this.info('')
    this.info('Stores:')
    for (const [name, store] of Object.entries(config.stores)) {
      const flag = name === config.default ? ' (default)' : ''
      this.info(`  ${name}${flag}: driver=${store.driver}`)
    }

    this.info('')
    this.info('Embedding:')
    this.info(`  provider: ${config.embedding.provider}`)
    this.info(`  model:    ${config.embedding.model}`)
    this.info(`  dim:      ${config.embedding.dimension}`)

    this.info('')
    this.info('Chunking:')
    this.info(`  strategy:  ${config.chunking.strategy}`)
    this.info(`  chunkSize: ${config.chunking.chunkSize}`)
    this.info(`  overlap:   ${config.chunking.overlap}`)
    if (config.chunking.separators) {
      this.info(`  separators: ${JSON.stringify(config.chunking.separators)}`)
    }
    return ExitCode.Success
  }
}
