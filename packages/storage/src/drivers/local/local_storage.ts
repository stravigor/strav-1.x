/**
 * `LocalStorage` — filesystem driver backed by `Bun.file` + `Bun.write`
 * + `node:fs/promises`.
 *
 * Right driver for: dev, tests, single-node deployments with a real
 * volume. Wrong driver for: serverless platforms with ephemeral disk
 * (Fly Machines, Vercel, etc.), multi-node deployments where every
 * node needs to see every file.
 *
 * `Bun.write` handles streams + Blobs + ArrayBuffers + strings
 * natively. We surface a single `put` that takes any of them. Parent
 * directories are created on demand — apps don't need to `mkdir`
 * before `put`.
 *
 * Listing walks `fs.readdir({ withFileTypes: true })`. `recursive:
 * true` traverses subdirectories; the default returns direct
 * children only (matching the S3 driver's delimiter semantic).
 *
 * `visibility` is recorded but not enforced — POSIX mode bits don't
 * map cleanly to "public vs private" across deployments. Apps that
 * serve uploads via a static handler against `root` get the
 * "public" semantic for free; signed-URL semantics live on the S3
 * driver.
 */

import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, sep as nativeSep, normalize, posix } from 'node:path'
import { normalizePrefix } from '../../path.ts'
import { Storage } from '../../storage.ts'
import { StorageDriverError, StorageNotFoundError } from '../../storage_error.ts'
import type {
  ListEntry,
  ListOptions,
  ListResult,
  PutOptions,
  SignedUrlOptions,
  StorageStat,
  StorageWriteable,
} from '../../types.ts'

export interface LocalStorageOptions {
  /**
   * Absolute root directory. All `put`/`get`/`delete` paths join with
   * this. Created on demand if missing.
   */
  root: string
  /**
   * Base URL prepended by `publicUrl()`. Typically the URL your static
   * handler serves `root` at — e.g. `'https://cdn.acme.com'` or
   * `'http://localhost:3000/files'`. Unset → `publicUrl()` throws.
   */
  publicBase?: string
}

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1000

export class LocalStorage extends Storage {
  private readonly root: string
  private readonly publicBase: string | undefined

  constructor(options: LocalStorageOptions) {
    super()
    this.root = options.root
    this.publicBase = options.publicBase
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  override async get(path: string): Promise<Uint8Array> {
    const key = this._normalize(path)
    const file = Bun.file(this.full(key))
    if (!(await file.exists())) {
      throw new StorageNotFoundError(`LocalStorage: no object at "${key}".`, {
        context: { path: key },
      })
    }
    return new Uint8Array(await file.arrayBuffer())
  }

  override async getString(path: string): Promise<string> {
    const key = this._normalize(path)
    const file = Bun.file(this.full(key))
    if (!(await file.exists())) {
      throw new StorageNotFoundError(`LocalStorage: no object at "${key}".`, {
        context: { path: key },
      })
    }
    return file.text()
  }

  override async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const key = this._normalize(path)
    const file = Bun.file(this.full(key))
    if (!(await file.exists())) {
      throw new StorageNotFoundError(`LocalStorage: no object at "${key}".`, {
        context: { path: key },
      })
    }
    return file.stream()
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  override async put(
    path: string,
    contents: StorageWriteable,
    // PutOptions are ignored on FS — recorded in docs.
    _options?: PutOptions,
  ): Promise<void> {
    const key = this._normalize(path)
    const target = this.full(key)
    await fs.mkdir(dirname(target), { recursive: true })
    try {
      // `Bun.write` accepts string / Uint8Array / ArrayBuffer / Blob
      // directly. ReadableStream isn't supported there — wrap it in a
      // Response first so we can let `Bun.write` consume the buffered
      // body. Memory-bounded by the caller's stream chunks; for large
      // uploads to FS this is fine.
      if (contents instanceof ReadableStream) {
        // Drain the stream into a Uint8Array before write. Bun.write
        // doesn't accept ReadableStream directly. For very large
        // payloads, callers should stream to S3 instead — the FS
        // driver is for single-node deployments where in-memory
        // buffering of an upload is acceptable.
        const buffered = await new Response(contents).bytes()
        await Bun.write(target, buffered)
      } else {
        await Bun.write(target, contents as Parameters<typeof Bun.write>[1])
      }
    } catch (cause) {
      throw new StorageDriverError(`LocalStorage: write failed for "${key}".`, {
        context: { path: key },
        cause,
      })
    }
  }

  // ─── Metadata ─────────────────────────────────────────────────────────────

  override async exists(path: string): Promise<boolean> {
    const key = this._normalize(path)
    try {
      await fs.access(this.full(key))
      return true
    } catch {
      return false
    }
  }

  override async stat(path: string): Promise<StorageStat> {
    const key = this._normalize(path)
    let st: Awaited<ReturnType<typeof fs.stat>>
    try {
      st = await fs.stat(this.full(key))
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new StorageNotFoundError(`LocalStorage: no object at "${key}".`, {
          context: { path: key },
        })
      }
      throw new StorageDriverError(`LocalStorage: stat failed for "${key}".`, {
        context: { path: key, code },
        cause,
      })
    }
    return {
      size: Number(st.size),
      lastModified: st.mtime,
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  override async delete(path: string): Promise<boolean> {
    const key = this._normalize(path)
    try {
      await fs.unlink(this.full(key))
      return true
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return false
      throw new StorageDriverError(`LocalStorage: delete failed for "${key}".`, {
        context: { path: key, code },
        cause,
      })
    }
  }

  override async copy(from: string, to: string): Promise<void> {
    const src = this._normalize(from)
    const dst = this._normalize(to)
    const target = this.full(dst)
    await fs.mkdir(dirname(target), { recursive: true })
    try {
      await fs.copyFile(this.full(src), target)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new StorageNotFoundError(`LocalStorage: source "${src}" does not exist.`, {
          context: { from: src, to: dst },
        })
      }
      throw new StorageDriverError(`LocalStorage: copy "${src}" → "${dst}" failed.`, {
        context: { from: src, to: dst, code },
        cause,
      })
    }
  }

  override async move(from: string, to: string): Promise<void> {
    const src = this._normalize(from)
    const dst = this._normalize(to)
    const target = this.full(dst)
    await fs.mkdir(dirname(target), { recursive: true })
    try {
      await fs.rename(this.full(src), target)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new StorageNotFoundError(`LocalStorage: source "${src}" does not exist.`, {
          context: { from: src, to: dst },
        })
      }
      if (code === 'EXDEV') {
        // Cross-volume — fall back to copy + delete.
        await fs.copyFile(this.full(src), target)
        await fs.unlink(this.full(src))
        return
      }
      throw new StorageDriverError(`LocalStorage: move "${src}" → "${dst}" failed.`, {
        context: { from: src, to: dst, code },
        cause,
      })
    }
  }

  // ─── Listing ──────────────────────────────────────────────────────────────

  override async list(options: ListOptions = {}): Promise<ListResult> {
    const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    const recursive = options.recursive ?? false
    const prefix = options.prefix !== undefined ? normalizePrefix(options.prefix) : ''
    const after = options.after

    // If the prefix is a directory path (`reports/2026/`), descend
    // straight into it. Otherwise walk the root + filter — that's the
    // path for partial-prefix matches (`prefix: 'reports/2026/jan-'`).
    let base = this.root
    let walkRelBase = ''
    let filterPrefix = prefix
    if (prefix !== '' && prefix.endsWith('/')) {
      // Strip the trailing slash and see if it's a real directory.
      const dirPath = prefix.slice(0, -1)
      try {
        const st = await fs.stat(join(this.root, dirPath))
        if (st.isDirectory()) {
          base = join(this.root, dirPath)
          walkRelBase = dirPath
          filterPrefix = ''
        }
      } catch {
        // Not a directory — fall through to root-walk + filter.
      }
    }

    const collected: ListEntry[] = []
    await this.walk(base, walkRelBase, recursive, (relPath, entry) => {
      if (filterPrefix !== '' && !relPath.startsWith(filterPrefix)) return false
      if (after !== undefined && relPath <= after) return false
      collected.push({
        path: relPath,
        ...(entry.isDirectory()
          ? { isDirectory: true }
          : {
              size: Number(entry.size),
              lastModified: entry.mtime,
              isDirectory: false,
            }),
      } as ListEntry)
      return collected.length < limit + 1 // gather one extra so we know there's a next page
    })

    const entries = collected.slice(0, limit)
    const cursor = collected.length > limit ? (entries.at(-1)?.path ?? undefined) : undefined
    return cursor !== undefined ? { entries, cursor } : { entries }
  }

  // ─── URLs ─────────────────────────────────────────────────────────────────

  override publicUrl(path: string): string {
    const key = this._normalize(path)
    if (this.publicBase === undefined) {
      throw new StorageDriverError(
        `LocalStorage: publicUrl("${key}") needs a configured \`publicBase\` (the URL your static handler serves \`root\` at).`,
        { context: { path: key } },
      )
    }
    return `${this.publicBase.replace(/\/$/, '')}/${key}`
  }

  override async signedUrl(_path: string, _options: SignedUrlOptions): Promise<string> {
    throw new StorageDriverError(
      'LocalStorage does not support signed URLs — there is no signing authority. Configure `publicBase` and serve via your static handler, or switch to the S3 driver for production.',
    )
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private full(key: string): string {
    // Reassemble using the native separator (Windows compat) but
    // collapse `..` defensively via `normalize` even though
    // `normalizePath` already rejected them.
    return normalize(join(this.root, key.split(posix.sep).join(nativeSep)))
  }

  private async walk(
    dir: string,
    relBase: string,
    recursive: boolean,
    visit: (
      relPath: string,
      entry: Awaited<ReturnType<typeof fs.stat>> & { isDirectory(): boolean },
    ) => boolean,
  ): Promise<boolean> {
    let entries: Dirent[]
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true
      throw new StorageDriverError(`LocalStorage: list walk failed at "${dir}".`, {
        context: { dir, code },
        cause,
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const dirent of entries) {
      const rel = relBase === '' ? dirent.name : `${relBase}/${dirent.name}`
      if (dirent.isDirectory()) {
        if (!recursive) {
          // Emit the directory entry then skip its contents.
          const cont = visit(rel, {
            ...(await fs.stat(join(dir, dirent.name))),
            isDirectory: () => true,
          })
          if (!cont) return false
          continue
        }
        const cont = await this.walk(join(dir, dirent.name), rel, true, visit)
        if (!cont) return false
        continue
      }
      const st = await fs.stat(join(dir, dirent.name))
      const cont = visit(rel, { ...st, isDirectory: () => false })
      if (!cont) return false
    }
    return true
  }
}
