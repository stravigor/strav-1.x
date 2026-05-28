/**
 * `bun strav view:build [--minify] [--sourcemap] [--islands-dir=…] [--out=…]`
 *
 * Bundles every `*.vue` island under `config.view.islandsDir`
 * (default `resources/islands`) into a single `islands.js` written to
 * `config.view.islandsOut` (default `public/assets/islands`).
 *
 * Output is minified by default (`--no-minify` disables it). Source
 * maps are off by default (`--sourcemap` enables inline source maps).
 *
 * Optional peer deps (`vue` + `@vue/compiler-sfc`) must be installed.
 * The command surfaces a clear error when they're missing rather than
 * crashing with a module-not-found stack trace.
 */

import { resolve } from 'node:path'
import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { ConfigRepository } from '@strav/kernel'
import { buildIslands } from '../islands/build_islands.ts'
import type { ViewConfig } from '../view_engine.ts'

export class ViewBuild extends Command {
  static signature = 'view:build {--islands-dir=} {--out=} {--no-minify} {--sourcemap}'
  static description = 'Bundle Vue island components into islands.js.'
  static providers = ['config', 'logger']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const config = this.app.resolve(ConfigRepository).get('view') as ViewConfig | undefined
    const cwd = process.cwd()

    const inputDir = resolve(
      cwd,
      (flags['islands-dir'] as string | undefined) || config?.islandsDir || 'resources/islands',
    )
    const outputDir = resolve(
      cwd,
      (flags.out as string | undefined) || config?.islandsOut || 'public/assets/islands',
    )
    const minify = flags['no-minify'] !== true
    const sourcemap = flags.sourcemap === true

    this.info(`Building islands: ${inputDir} → ${outputDir}`)

    try {
      const result = await buildIslands({ inputDir, outputDir, minify, sourcemap })
      this.success(`Built ${result.islands.length} island(s) → ${result.output}`)
      for (const name of result.islands) this.line(`  ✓ ${name}`)
      if (result.setups.length > 0) {
        this.line(`  setup: ${result.setups.join(', ')}`)
      }
      return ExitCode.Success
    } catch (err) {
      this.error(`view:build failed: ${(err as Error).message ?? String(err)}`)
      return ExitCode.GenericFailure
    }
  }
}
