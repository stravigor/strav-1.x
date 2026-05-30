/**
 * Public types for `@strav/storage`.
 *
 * Drivers implement a tight set of primitive ops + URL helpers; the
 * abstract base composes higher-level helpers (`getString`,
 * `getStream`, `move`) on top.
 */

/**
 * What `put()` accepts as a body. Strings are encoded as UTF-8.
 * `ReadableStream` is preferred for large uploads — drivers stream
 * the payload to the backend instead of buffering in memory.
 */
export type StorageWriteable = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>

/**
 * What `stat()` returns about an object.
 *
 * `contentType` and `etag` are optional — drivers populate them when
 * the backend supplies them (S3 always; LocalStorage doesn't track
 * content-type, leaves it `undefined`).
 */
export interface StorageStat {
  /** Byte count. */
  size: number
  lastModified: Date
  /** MIME type the object was stored under. Optional. */
  contentType?: string
  /** Provider-side strong hash, when available. */
  etag?: string
}

export interface PutOptions {
  /**
   * MIME type. On S3 this rides on the `Content-Type` header and is
   * returned from `stat()`. On LocalStorage it's ignored — the FS
   * stores bytes, not media types.
   */
  contentType?: string
  /** Sets the `Cache-Control` response header on S3 GETs. Ignored on FS. */
  cacheControl?: string
  /** Sets `Content-Encoding`. Ignored on FS. */
  contentEncoding?: string
  /**
   * User-defined key/value metadata stored alongside the object.
   * Round-trips on S3 (as `x-amz-meta-*`); ignored on FS.
   */
  metadata?: Record<string, string>
  /**
   * Object visibility. Default `'private'`.
   *
   *   - `'private'` — the object is only accessible via signed URLs.
   *     S3 sets `acl: 'private'`; LocalStorage records this as a hint
   *     but enforces nothing (filesystem permissions don't map
   *     cleanly across deployments).
   *   - `'public'` — anyone can read the object. S3 sets
   *     `acl: 'public-read'`. LocalStorage assumes the configured
   *     `publicBase` is served by your static handler.
   */
  visibility?: 'private' | 'public'
}

export interface ListOptions {
  /**
   * Limit results to keys beginning with this prefix. POSIX-style
   * (`reports/2026/`).
   */
  prefix?: string
  /**
   * Cursor from a previous `ListResult.cursor`. Resume listing past
   * the last key returned.
   */
  after?: string
  /**
   * Max entries to return in one page. Drivers cap higher values:
   * S3 maxes at 1000, the filesystem driver matches that ceiling.
   * Default `100`.
   */
  limit?: number
  /**
   * When `true`, walks into subdirectories (FS) / treats every key
   * as a flat namespace (S3 — keys with `/` already span "folders").
   * Default `false`: FS returns only direct children; S3 honours the
   * `Delimiter: '/'` semantic so subdirectory prefixes surface as
   * `isDirectory: true` entries.
   */
  recursive?: boolean
}

export interface ListEntry {
  /** Key relative to the storage root. POSIX-style. */
  path: string
  /** Byte count. Undefined for directory entries on FS. */
  size?: number
  lastModified?: Date
  /**
   * `true` for "common prefix" entries on S3 with delimiter
   * semantics, and for FS directories. `false` / undefined for
   * regular files.
   */
  isDirectory?: boolean
}

export interface ListResult {
  entries: ListEntry[]
  /** When set, pass back as `ListOptions.after` to fetch the next page. */
  cursor?: string
}

export interface SignedUrlOptions {
  /** Expiry in seconds. Required — pre-signed URLs without bounds are an anti-pattern. */
  expiresIn: number
  /** HTTP method the URL is signed for. Default `'GET'`. */
  method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  /**
   * Override the response `Content-Type` when the URL is fetched.
   * S3 sets the `response-content-type` query param; ignored on FS
   * (which can't sign URLs anyway).
   */
  responseContentType?: string
}
