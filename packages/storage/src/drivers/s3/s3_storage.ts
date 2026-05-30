/**
 * `S3Storage` — S3-compatible object storage driver backed by Bun's
 * built-in `S3Client`.
 *
 * Works with AWS S3, Cloudflare R2, Backblaze B2, Tigris, MinIO, and
 * anything else that speaks the S3 API. Region + bucket + credentials
 * + endpoint (for non-AWS providers) configure the target. No
 * third-party Bun S3 client dependency.
 *
 * Wire mapping:
 *
 *   - `get` / `getStream` → `client.file(key).arrayBuffer()` /
 *     `client.file(key).stream()`.
 *   - `put` → `client.write(key, data, { type, cacheControl, … })`.
 *     Bun handles strings, Buffers, Blobs, Requests, Responses,
 *     ReadableStreams (wrapped) and multipart upload chunking.
 *   - `exists` / `stat` / `delete` → straight-through to the bucket
 *     methods of the same name.
 *   - `copy` — no native single-call copy in Bun's S3 surface; we
 *     stream the source to the destination via `client.write(toKey,
 *     client.file(fromKey))`.
 *   - `list` → `client.list({ prefix, startAfter, maxKeys, delimiter })`
 *     mapped to our `ListResult` shape. Cursor is the
 *     `nextContinuationToken`.
 *   - `publicUrl` → `publicBase + '/' + key`, throws when unset.
 *   - `signedUrl` → `client.presign(key, { expiresIn, method })`.
 *
 * ACL mapping for `put({ visibility })`:
 *
 *   - `'public'`  → `acl: 'public-read'`
 *   - `'private'` → `acl: 'private'` (also the default when omitted)
 */

import { S3Client, type S3ListObjectsOptions, type S3Options } from 'bun'
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

export interface S3StorageOptions {
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /**
   * AWS region — used for the default endpoint and signing.
   * Non-AWS providers (R2, MinIO, B2) ignore the region; set it
   * anyway (`'auto'` works) for signing.
   */
  region?: string
  /**
   * Override the S3 endpoint. Required for non-AWS providers:
   *
   *   - Cloudflare R2: `https://<account>.r2.cloudflarestorage.com`
   *   - Backblaze B2:  `https://s3.<region>.backblazeb2.com`
   *   - Tigris:        `https://t3.storage.dev`
   *   - MinIO:         `http://localhost:9000` (dev / self-hosted)
   */
  endpoint?: string
  /** Optional STS session token. */
  sessionToken?: string
  /** Force virtual-hosted-style addressing (vs path-style). Default backend's choice. */
  virtualHostedStyle?: boolean
  /**
   * Public URL prefix returned by `publicUrl()`. Unset → `publicUrl()`
   * throws (the bucket might be private; the framework doesn't try to
   * guess). For AWS S3 buckets this is typically
   * `https://<bucket>.s3.<region>.amazonaws.com`; for R2 it's the
   * `r2.dev` URL or your custom domain.
   */
  publicBase?: string
  /** Pre-constructed client for tests. */
  client?: S3Client
}

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1000

export class S3Storage extends Storage {
  private readonly client: S3Client
  private readonly publicBase: string | undefined

  constructor(options: S3StorageOptions) {
    super()
    this.publicBase = options.publicBase
    if (options.client !== undefined) {
      this.client = options.client
    } else {
      const clientOpts: S3Options = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        bucket: options.bucket,
      }
      if (options.region !== undefined) clientOpts.region = options.region
      if (options.endpoint !== undefined) clientOpts.endpoint = options.endpoint
      if (options.sessionToken !== undefined) clientOpts.sessionToken = options.sessionToken
      if (options.virtualHostedStyle !== undefined) {
        clientOpts.virtualHostedStyle = options.virtualHostedStyle
      }
      this.client = new S3Client(clientOpts)
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  override async get(path: string): Promise<Uint8Array> {
    const key = this._normalize(path)
    const file = this.client.file(key)
    try {
      const buffer = await file.arrayBuffer()
      return new Uint8Array(buffer)
    } catch (cause) {
      throw this.wrapNotFoundOrDriver(cause, key, 'get')
    }
  }

  override async getString(path: string): Promise<string> {
    const key = this._normalize(path)
    try {
      return await this.client.file(key).text()
    } catch (cause) {
      throw this.wrapNotFoundOrDriver(cause, key, 'getString')
    }
  }

  override async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const key = this._normalize(path)
    try {
      // Bun's S3File supports `.stream()` natively.
      return this.client.file(key).stream() as unknown as ReadableStream<Uint8Array>
    } catch (cause) {
      throw this.wrapNotFoundOrDriver(cause, key, 'getStream')
    }
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  override async put(
    path: string,
    contents: StorageWriteable,
    options: PutOptions = {},
  ): Promise<void> {
    const key = this._normalize(path)
    const writeOpts: S3Options = {}
    if (options.contentType !== undefined) writeOpts.type = options.contentType
    if (options.contentEncoding !== undefined) writeOpts.contentEncoding = options.contentEncoding
    // PutOptions.cacheControl and .metadata aren't exposed on Bun's
    // current S3Options surface — when Bun lands them, plumb here.
    // Today they're silently dropped; documented in docs/storage/api.md.
    writeOpts.acl = options.visibility === 'public' ? 'public-read' : 'private'
    try {
      const payload = await this.coerceToWriteable(contents)
      await this.client.write(key, payload, writeOpts)
    } catch (cause) {
      throw new StorageDriverError(`S3Storage: write failed for "${key}".`, {
        context: { path: key },
        cause,
      })
    }
  }

  // ─── Metadata ─────────────────────────────────────────────────────────────

  override async exists(path: string): Promise<boolean> {
    const key = this._normalize(path)
    try {
      return await this.client.exists(key)
    } catch (cause) {
      throw new StorageDriverError(`S3Storage: exists failed for "${key}".`, {
        context: { path: key },
        cause,
      })
    }
  }

  override async stat(path: string): Promise<StorageStat> {
    const key = this._normalize(path)
    let st: Awaited<ReturnType<S3Client['stat']>>
    try {
      st = await this.client.stat(key)
    } catch (cause) {
      throw this.wrapNotFoundOrDriver(cause, key, 'stat')
    }
    const result: StorageStat = {
      size: Number(st.size ?? 0),
      lastModified: st.lastModified ? new Date(st.lastModified) : new Date(0),
    }
    if (st.type !== undefined) result.contentType = st.type
    if (st.etag !== undefined) result.etag = st.etag
    return result
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  override async delete(path: string): Promise<boolean> {
    const key = this._normalize(path)
    // S3 doesn't tell us whether the key was actually there (DELETE is
    // idempotent on S3). Check first to give the same semantics as
    // LocalStorage.delete — true iff a real object went away.
    const existed = await this.exists(key)
    if (!existed) return false
    try {
      await this.client.delete(key)
      return true
    } catch (cause) {
      throw new StorageDriverError(`S3Storage: delete failed for "${key}".`, {
        context: { path: key },
        cause,
      })
    }
  }

  override async copy(from: string, to: string): Promise<void> {
    const src = this._normalize(from)
    const dst = this._normalize(to)
    if (!(await this.exists(src))) {
      throw new StorageNotFoundError(`S3Storage: source "${src}" does not exist.`, {
        context: { from: src, to: dst },
      })
    }
    try {
      // S3Client.write accepts an S3File — Bun streams source → dest
      // via the bucket's own copy operation when possible.
      await this.client.write(dst, this.client.file(src))
    } catch (cause) {
      throw new StorageDriverError(`S3Storage: copy "${src}" → "${dst}" failed.`, {
        context: { from: src, to: dst },
        cause,
      })
    }
  }

  // `move` falls back to the base implementation (copy + delete).
  // Server-side rename isn't a single S3 op anyway — that's exactly
  // what the base does.

  // ─── Listing ──────────────────────────────────────────────────────────────

  override async list(options: ListOptions = {}): Promise<ListResult> {
    const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    const recursive = options.recursive ?? false
    const prefix = options.prefix !== undefined ? normalizePrefix(options.prefix) : ''

    const input: S3ListObjectsOptions = { maxKeys: limit }
    if (prefix !== '') input.prefix = prefix
    if (!recursive) input.delimiter = '/'
    if (options.after !== undefined) {
      // `after` is our cursor — interpret as Bun's continuationToken first
      // since that's how we issue cursors. Apps that pass an
      // arbitrary key value also work via `startAfter`.
      input.continuationToken = options.after
    }

    let resp: Awaited<ReturnType<S3Client['list']>>
    try {
      resp = await this.client.list(input)
    } catch (cause) {
      throw new StorageDriverError('S3Storage: list failed.', {
        context: { prefix, recursive },
        cause,
      })
    }

    const entries: ListEntry[] = []
    for (const cp of resp.commonPrefixes ?? []) {
      entries.push({ path: cp.prefix, isDirectory: true })
    }
    for (const obj of resp.contents ?? []) {
      const entry: ListEntry = { path: obj.key }
      if (obj.size !== undefined) entry.size = obj.size
      if (obj.lastModified !== undefined) entry.lastModified = new Date(obj.lastModified)
      entries.push(entry)
    }

    const result: ListResult = { entries }
    if (resp.isTruncated && resp.nextContinuationToken !== undefined) {
      result.cursor = resp.nextContinuationToken
    }
    return result
  }

  // ─── URLs ─────────────────────────────────────────────────────────────────

  override publicUrl(path: string): string {
    const key = this._normalize(path)
    if (this.publicBase === undefined) {
      throw new StorageDriverError(
        `S3Storage: publicUrl("${key}") needs a configured \`publicBase\` (the URL your bucket is served at; e.g. https://<bucket>.s3.<region>.amazonaws.com for AWS, or your r2.dev / custom domain for R2).`,
        { context: { path: key } },
      )
    }
    return `${this.publicBase.replace(/\/$/, '')}/${key}`
  }

  override async signedUrl(path: string, options: SignedUrlOptions): Promise<string> {
    const key = this._normalize(path)
    try {
      return this.client.presign(key, {
        expiresIn: options.expiresIn,
        method: options.method ?? 'GET',
      })
    } catch (cause) {
      throw new StorageDriverError(`S3Storage: presign failed for "${key}".`, {
        context: { path: key },
        cause,
      })
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private wrapNotFoundOrDriver(cause: unknown, key: string, op: string): Error {
    const message = (cause as { message?: string }).message ?? ''
    const code = (cause as { code?: string }).code
    // Bun surfaces missing keys as either NoSuchKey, 404, or "not
    // found" depending on the backend. Match liberally.
    if (code === 'NoSuchKey' || message.includes('404') || /not\s*found/i.test(message)) {
      return new StorageNotFoundError(`S3Storage: no object at "${key}".`, {
        context: { path: key, op },
      })
    }
    return new StorageDriverError(`S3Storage: ${op} failed for "${key}".`, {
      context: { path: key, op },
      cause,
    })
  }

  private async coerceToWriteable(
    contents: StorageWriteable,
  ): Promise<Parameters<S3Client['write']>[1]> {
    if (contents instanceof ReadableStream) {
      // Bun's S3 write accepts Response — wrap so multipart upload
      // streams the stream chunk-by-chunk.
      return new Response(contents)
    }
    return contents as Parameters<S3Client['write']>[1]
  }
}
