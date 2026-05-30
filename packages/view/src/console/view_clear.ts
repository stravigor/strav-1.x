/**
 * `bun strav view:clear` — drop the in-memory view cache AND the
 * on-disk cache directory (`storage/cache/views` by default).
 *
 * The next render() call for each template will re-read + re-compile
 * from disk. Useful after deploying new templates without bouncing the
 * process, or to reclaim memory during development.
 */

import { Command, ExitCode } from '@strav/cli'
import { ViewEngine } from '../view_engine.ts'

export class ViewClear extends Command {
  static signature = 'view:clear'
  static description = 'Clear the compiled template cache (memory + disk).'
  static providers = ['config', 'logger', 'view']

  override async execute(): Promise<number> {
    const engine = this.app.resolve(ViewEngine)
    engine.clearCache()
    await engine.clearDiskCache()
    const diskDir = engine.diskCacheDirectory
    if (diskDir !== undefined) {
      this.success(`View cache cleared (memory + ${diskDir}).`)
    } else {
      this.success('View cache cleared.')
    }
    return ExitCode.Success
  }
}
