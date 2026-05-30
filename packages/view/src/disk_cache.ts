/**
 * `DiskCache` — persist compiled `.strav` templates between process
 * boots.
 *
 * The in-memory cache (held by `ViewEngine`) is fast but cold-starts
 * lose it. Disk persistence means a freshly-started process can skip
 * tokenize + compile for any template whose source hasn't changed,
 * which matters at scale (hundreds of templates × multi-worker boots).
 *
 * On-disk layout — one file per template, keyed by a hash of the
 * template's source. The filename is the hash; the body is JSON:
 *
 *   {
 *     "name": "pages.dashboard",
 *     "layout": "layouts.app",          // omitted when absent
 *     "source": "async function __render(__data, __ctx) { … }"
 *   }
 *
 * The hash is over the source text only — when a template file
 * changes, the next compile writes a new entry; the stale one stays
 * until `view:clear` runs (or until apps periodically prune). Hashing
 * by content (not mtime) means cache files survive `touch` and other
 * timestamp changes that don't alter behaviour.
 *
 * Failures in disk operations are non-fatal: the engine falls back to
 * in-process compile + memory cache. Disk cache is a speed-up, not a
 * correctness layer.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CompilationResult } from './compiler.ts'
import { TemplateError } from './template_error.ts'

interface OnDiskEntry {
  name: string
  layout?: string
  source: string
}

export class DiskCache {
  readonly directory: string
  private ensuredDir = false

  constructor(directory: string) {
    this.directory = resolve(directory)
  }

  /** Compute the on-disk key for `(name, source)`. */
  keyFor(name: string, source: string): string {
    // Bun.hash is a fast non-crypto 64-bit hash — collision risk is
    // negligible for a per-app template set. The name is included so
    // distinct templates with identical (empty) sources don't collide.
    const hash = Bun.hash(`${name}\0${source}`).toString(16)
    return `${hash}.json`
  }

  /**
   * Try to load a cached compilation for `(name, source)`. Returns
   * `undefined` on miss or any read failure. Never throws — disk cache
   * is a speed-up, not a correctness layer.
   */
  async read(name: string, source: string): Promise<CompilationResult | undefined> {
    const path = join(this.directory, this.keyFor(name, source))
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return undefined
    }
    let entry: OnDiskEntry
    try {
      entry = JSON.parse(raw) as OnDiskEntry
    } catch {
      return undefined
    }
    if (typeof entry.source !== 'string') return undefined
    try {
      const fn = new Function('__data', '__ctx', entry.source) as CompilationResult['render']
      return { render: fn, layout: entry.layout, source: entry.source }
    } catch {
      return undefined
    }
  }

  /**
   * Persist `compiled` for `(name, source)`. Best-effort — write errors
   * (read-only fs, missing perms) are swallowed so app boot keeps
   * running even when the cache dir isn't writable.
   */
  async write(name: string, source: string, compiled: CompilationResult): Promise<void> {
    const path = join(this.directory, this.keyFor(name, source))
    const entry: OnDiskEntry = { name, source: compiled.source }
    if (compiled.layout !== undefined) entry.layout = compiled.layout
    try {
      await this.ensureDir()
      await writeFile(path, JSON.stringify(entry), 'utf8')
    } catch {
      // Intentionally swallowed — see class doc.
    }
  }

  /** Remove every cached compilation. Used by `view:clear`. */
  async clear(): Promise<void> {
    try {
      await rm(this.directory, { recursive: true, force: true })
      this.ensuredDir = false
    } catch (cause) {
      throw new TemplateError(`Failed to clear disk cache at '${this.directory}'.`, {
        cause,
        context: { directory: this.directory },
      })
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.ensuredDir) return
    await mkdir(this.directory, { recursive: true })
    this.ensuredDir = true
  }
}
