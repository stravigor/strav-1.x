/**
 * `bun strav view:build [--minify] [--sourcemap] [--islands-dir=…] [--out=…] [--no-css] [--watch]`
 *
 * Two passes:
 *
 *   1. **Islands** — bundles every `*.vue` under `config.view.islandsDir`
 *      (default `resources/islands`) into a single `islands.js` written
 *      to `config.view.islandsOut` (default `public/assets/islands`).
 *
 *   2. **CSS** — bundles each entry in `config.view.css.inputs`
 *      (default `['resources/css/app.css']`) into
 *      `config.view.css.outputDir` (default `public/assets`). The
 *      0.x Sass pipeline isn't ported; Bun's CSS bundler walks
 *      `@import`s and minifies, which covers the modern Tailwind /
 *      PostCSS workflow without the heavy dep. Apps that want Sass
 *      preprocess to CSS first.
 *
 * Output is minified by default (`--no-minify` disables it). Source
 * maps are off by default (`--sourcemap` enables inline source maps).
 * `--no-css` skips the CSS pass entirely.
 *
 * `--watch` runs an initial build, then watches the islands directory
 * (recursively) AND every CSS input file for changes, debouncing
 * rebuilds at 150ms. Ctrl+C exits cleanly. Watching deliberately does
 * NOT walk into `node_modules`, the output directory, or the build's
 * own temp entry (`.strav-build-entry-*`) — those would otherwise
 * trigger rebuild storms.
 *
 * Peer deps (`vue` + `@vue/compiler-sfc`) must be installed for the
 * islands pass. The command surfaces a clear error when they're
 * missing rather than crashing with a module-not-found stack trace.
 */

import { existsSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'
import { ConfigRepository } from '@strav/kernel'
import { buildCss } from '../islands/build_css.ts'
import { buildIslands } from '../islands/build_islands.ts'
import type { ViewConfig } from '../view_engine.ts'

const WATCH_DEBOUNCE_MS = 150
const WATCH_IGNORE_RE = /(?:^|[\\/])(?:node_modules|\.strav-build-entry-|\.git)/

export class ViewBuild extends Command {
  static signature =
    'view:build {--islands-dir=} {--out=} {--no-minify} {--sourcemap} {--no-css} {--watch}'
  static description = 'Bundle Vue island components into islands.js and bundle CSS entries.'
  static providers = ['config', 'logger']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const config = this.app.resolve(ConfigRepository).get('view') as ViewConfig | undefined
    const cwd = process.cwd()

    // Islands source resolution — multi-source `islandSources` wins
    // over the single `islandsDir` shorthand; CLI `--islands-dir` is
    // a top-level override that forces single-source mode.
    // The CLI flag parser reports unset value-flags as `''`, not
    // `undefined` — treat both as "not provided".
    const cliInputDirRaw = flags['islands-dir'] as string | undefined
    const cliInputDir =
      cliInputDirRaw !== undefined && cliInputDirRaw !== '' ? cliInputDirRaw : undefined
    let sources: Array<{ inputDir: string; namespace?: string }>
    if (cliInputDir !== undefined) {
      sources = [{ inputDir: resolve(cwd, cliInputDir) }]
    } else if (config?.islandSources !== undefined) {
      sources = config.islandSources.map((s) => ({
        inputDir: resolve(cwd, s.inputDir),
        namespace: s.namespace,
      }))
    } else {
      sources = [{ inputDir: resolve(cwd, config?.islandsDir || 'resources/islands') }]
    }
    const cliOut = flags.out as string | undefined
    const outputDir = resolve(
      cwd,
      (cliOut !== undefined && cliOut !== '' ? cliOut : undefined) ||
        config?.islandsOut ||
        'public/assets/islands',
    )
    const minify = flags['no-minify'] !== true
    const sourcemap = flags.sourcemap === true
    const cssEnabled = flags['no-css'] !== true
    const watchMode = flags.watch === true

    const cssOutputDir = resolve(cwd, config?.css?.outputDir ?? 'public/assets')
    const cssInputsRaw: readonly string[] | Record<string, string> =
      config?.css?.inputs ?? ['resources/css/app.css']

    /**
     * Materialise `config.view.css.inputs` (which can be a string
     * array or a name→path record) into an array of resolved entries
     * keyed by name. Entries whose source file is missing on disk are
     * filtered out — keeps backend-only apps from failing the build.
     */
    const resolveCssEntries = (): Array<{ name: string; input: string }> => {
      if (Array.isArray(cssInputsRaw)) {
        return cssInputsRaw
          .map((p) => {
            const abs = resolve(cwd, p)
            const base = abs.split('/').pop() ?? abs
            return { name: base.replace(/\.css$/i, ''), input: abs }
          })
          .filter((e) => existsSync(e.input))
      }
      return Object.entries(cssInputsRaw)
        .map(([name, p]) => ({ name, input: resolve(cwd, p) }))
        .filter((e) => existsSync(e.input))
    }

    const runOnce = async (): Promise<number> => {
      if (sources.length === 1) {
        this.info(`Building islands: ${sources[0]!.inputDir} → ${outputDir}`)
      } else {
        this.info(`Building islands: ${sources.length} source(s) → ${outputDir}`)
        for (const s of sources) {
          this.line(`  • ${s.namespace ? `[${s.namespace}] ` : ''}${s.inputDir}`)
        }
      }
      try {
        const result =
          sources.length === 1
            ? await buildIslands({
                inputDir: sources[0]!.inputDir,
                outputDir,
                minify,
                sourcemap,
              })
            : await buildIslands({ sources, outputDir, minify, sourcemap })
        this.success(`Built ${result.islands.length} island(s) → ${result.output}`)
        for (const name of result.islands) this.line(`  ✓ ${name}`)
        if (result.setups.length > 0) {
          this.line(`  setup: ${result.setups.join(', ')}`)
        }
      } catch (err) {
        this.error(`view:build failed: ${(err as Error).message ?? String(err)}`)
        return ExitCode.GenericFailure
      }

      if (!cssEnabled) return ExitCode.Success

      const cssEntries = resolveCssEntries()
      if (cssEntries.length === 0) return ExitCode.Success

      this.info(`Building CSS: ${cssEntries.length} entry → ${cssOutputDir}`)
      try {
        const cssResult = await buildCss({
          inputs: cssEntries,
          outputDir: cssOutputDir,
          minify,
          sourcemap,
        })
        this.success(`Built ${cssResult.outputs.length} stylesheet(s).`)
        for (const e of cssResult.entries) this.line(`  ✓ ${e.name} → ${e.output}`)
      } catch (err) {
        this.error(`view:build (css) failed: ${(err as Error).message ?? String(err)}`)
        return ExitCode.GenericFailure
      }
      return ExitCode.Success
    }

    const firstExit = await runOnce()
    if (!watchMode) return firstExit

    // ─── Watch loop ──────────────────────────────────────────────────────
    this.info('Watching for changes (Ctrl+C to stop)…')

    let debounce: ReturnType<typeof setTimeout> | undefined
    let running = false
    let pending = false

    const trigger = (path: string): void => {
      if (WATCH_IGNORE_RE.test(path)) return
      if (debounce !== undefined) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        void rebuild()
      }, WATCH_DEBOUNCE_MS)
    }

    const rebuild = async (): Promise<void> => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        await runOnce()
      } finally {
        running = false
        if (pending) {
          pending = false
          void rebuild()
        }
      }
    }

    const watchers: FSWatcher[] = []
    // Watch each islands tree recursively. `recursive: true` is
    // supported on macOS + Windows natively; Linux falls back to
    // a per-directory walk inside Bun's polyfill — still fine for
    // the typical `resources/ts/islands/` + per-module trees.
    for (const src of sources) {
      if (!existsSync(src.inputDir)) continue
      try {
        watchers.push(
          watch(src.inputDir, { recursive: true }, (_event, filename) => {
            if (filename !== null) trigger(filename)
          }),
        )
      } catch (err) {
        this.warn(`Could not watch ${src.inputDir}: ${(err as Error).message}`)
      }
    }

    // Watch each CSS input file directly. `@import`-ed siblings won't
    // re-trigger automatically — apps that need deep CSS dependency
    // tracking add their files to `config.view.css.inputs` or
    // restart `view:build --watch` after a structural change.
    for (const entry of resolveCssEntries()) {
      try {
        watchers.push(
          watch(entry.input, () => trigger(entry.input)),
        )
      } catch (err) {
        this.warn(`Could not watch ${entry.input}: ${(err as Error).message}`)
      }
    }

    const shutdown = (): void => {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // Best-effort — already-closed watchers throw on Linux.
        }
      }
      process.exit(ExitCode.Success)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    // Park forever; the watchers drive the loop.
    await new Promise<void>(() => {})
    return ExitCode.Success // unreachable
  }
}
