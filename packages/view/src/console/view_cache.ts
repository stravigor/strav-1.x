/**
 * `bun strav view:cache` — pre-compile every .strav template.
 *
 * Walks `config.view.directory` (default `resources/views`), compiles
 * each `*.strav` file into the ViewEngine's in-memory cache, and
 * reports how many templates were warmed. Files that fail to compile
 * are printed as warnings but don't exit non-zero — partial warming
 * is still useful.
 */

import { Command, ExitCode } from '@strav/cli'
import { ViewEngine } from '../view_engine.ts'

export class ViewCache extends Command {
  static signature = 'view:cache'
  static description = 'Pre-compile all .strav templates into the view cache.'
  static providers = ['config', 'logger', 'view']

  override async execute(): Promise<number> {
    const engine = this.app.resolve(ViewEngine)
    const { warmed, errors } = await engine.warmCache()
    if (warmed.length === 0 && errors.length === 0) {
      this.info('No .strav templates found.')
      return ExitCode.Success
    }
    this.success(`Cached ${warmed.length} template(s).`)
    for (const name of warmed) this.line(`  ✓ ${name}`)
    if (errors.length > 0) {
      this.warn(`${errors.length} template(s) failed to compile:`)
      for (const { name, error } of errors) {
        this.error(`  ✗ ${name}: ${(error as Error).message ?? String(error)}`)
      }
    }
    return ExitCode.Success
  }
}
