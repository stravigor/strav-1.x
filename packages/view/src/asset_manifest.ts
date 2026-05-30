/**
 * `AssetManifest` — implementation behind the `@asset(path)` directive
 * and the `asset()` template helper.
 *
 * Two modes, picked at construction:
 *
 *   Manifest mode  — the app ran a bundler (Vite, Bun.build, esbuild)
 *                    that wrote a JSON manifest mapping logical paths
 *                    to fingerprinted output paths. The most common
 *                    shape is `{ "css/app.css": "css/app.abc123.css" }`
 *                    (Vite emits a richer schema; we read the
 *                    canonical `file` field when present).
 *
 *   Dev fallback   — no manifest present. `version(path)` falls back
 *                    to `?v=<mtime-hash>` so the browser refreshes
 *                    when the file on disk changes, but the URL still
 *                    points at the original path.
 *
 * Both modes prepend `prefix` (default `/`) — apps serving assets
 * from a CDN set `prefix: 'https://cdn.example.com/'`.
 *
 * Resolution is cached per-call to avoid stat'ing the disk on every
 * render. The cache is reset by `reload()` (used by `view:clear`).
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export interface AssetManifestOptions {
  /**
   * Directory the bundler writes into. Used both to locate the
   * manifest (if not given explicitly) and to stat source files for
   * mtime-based versioning when no manifest is present.
   *
   * Default `'public'` (resolved against `cwd` if relative).
   */
  publicDir?: string
  /**
   * Absolute or relative path to the manifest JSON. Defaults to
   * `<publicDir>/manifest.json`. Apps using Vite typically point this
   * at `public/build/.vite/manifest.json`.
   */
  manifest?: string
  /**
   * URL prefix prepended to every resolved path. Default `'/'`.
   * Trailing slash is optional — the resolver normalises.
   */
  prefix?: string
}

export class AssetManifest {
  private readonly publicDir: string
  private readonly manifestPath: string
  private readonly prefix: string
  private readonly cache = new Map<string, string>()
  private manifest: Record<string, string> | undefined
  private manifestLoaded = false

  constructor(opts: AssetManifestOptions = {}) {
    const cwd = process.cwd()
    const publicDir = opts.publicDir ?? 'public'
    this.publicDir = isAbsolute(publicDir) ? publicDir : resolve(cwd, publicDir)
    const manifestPath = opts.manifest ?? join(this.publicDir, 'manifest.json')
    this.manifestPath = isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath)
    const prefix = opts.prefix ?? '/'
    this.prefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  }

  /**
   * Resolve `path` to a versioned URL. Empty / absolute-URL inputs
   * pass through unchanged (apps occasionally pipe full `https://…`
   * URLs through `asset()` for symmetry — don't break them).
   */
  version(path: string): string {
    if (path === '') return path
    if (/^[a-z][\w+.-]*:\/\//i.test(path)) return path
    if (path.startsWith('//')) return path

    const cached = this.cache.get(path)
    if (cached !== undefined) return cached

    const resolved = this.resolveOne(path)
    this.cache.set(path, resolved)
    return resolved
  }

  /** Force a manifest + cache reload. Used by `view:clear`. */
  reload(): void {
    this.cache.clear()
    this.manifest = undefined
    this.manifestLoaded = false
  }

  /**
   * Eager-load the manifest. The first `version()` call would do this
   * lazily — apps that want boot-time failure for a missing manifest
   * call this in `boot()` instead.
   */
  async load(): Promise<void> {
    if (this.manifestLoaded) return
    this.manifestLoaded = true
    if (!existsSync(this.manifestPath)) {
      this.manifest = undefined
      return
    }
    try {
      const raw = await readFile(this.manifestPath, 'utf8')
      this.manifest = normaliseManifest(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      this.manifest = undefined
    }
  }

  private resolveOne(path: string): string {
    this.ensureManifestSync()
    const cleaned = path.replace(/^\/+/, '')
    const entry = this.manifest?.[cleaned]
    if (entry !== undefined) return this.prefix + entry.replace(/^\/+/, '')

    // Dev fallback — append mtime hash if the file exists on disk.
    const abs = join(this.publicDir, cleaned)
    if (existsSync(abs)) {
      try {
        const mtime = statSync(abs).mtimeMs
        const v = Bun.hash(String(mtime)).toString(16).slice(0, 8)
        return `${this.prefix}${cleaned}?v=${v}`
      } catch {
        // fall through
      }
    }
    return this.prefix + cleaned
  }

  private ensureManifestSync(): void {
    if (this.manifestLoaded) return
    this.manifestLoaded = true
    if (!existsSync(this.manifestPath)) return
    try {
      // One sync read on first access — the manifest is small and the
      // `asset()` directive is sync from the template's POV.
      const text = readFileSync(this.manifestPath, 'utf8')
      this.manifest = normaliseManifest(JSON.parse(text) as Record<string, unknown>)
    } catch {
      this.manifest = undefined
    }
  }
}

/**
 * Collapse the two common manifest shapes to a flat `path → file` map.
 *
 *   { "css/app.css": "css/app.abc123.css" }            // strav default
 *   { "css/app.css": { "file": "css/app.abc123.css" }} // vite-style
 */
function normaliseManifest(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[key] = value
    } else if (value !== null && typeof value === 'object' && 'file' in value) {
      const file = (value as { file: unknown }).file
      if (typeof file === 'string') out[key] = file
    }
  }
  return out
}
