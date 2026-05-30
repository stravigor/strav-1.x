/**
 * `Storage` — abstract base + container token.
 *
 * Non-`abstract` on purpose: serves as the `app.singleton(Storage,
 * factory)` token (same trade-off as `Cache` / `Broadcaster`).
 * Subclasses MUST override the primitives; the defaults throw to
 * surface forgotten overrides during development.
 *
 * Driver primitives:
 *
 *   - `get(path)` → `Uint8Array`
 *   - `put(path, contents, options?)`
 *   - `exists(path)` → `boolean`
 *   - `stat(path)` → `StorageStat`
 *   - `delete(path)` → `boolean` (true if a row was actually removed)
 *   - `copy(from, to)`
 *   - `list(options?)` → `ListResult`
 *   - `publicUrl(path)` → `string` (throws when `publicBase` unset)
 *   - `signedUrl(path, options)` → `string`
 *
 * The base provides:
 *
 *   - `getString(path, encoding?)` — UTF-8 decoded `get`
 *   - `getStream(path)` — driver overrides to stream; the base
 *     synthesizes a one-chunk `ReadableStream` from `get` as a
 *     fallback so apps can always rely on the API
 *   - `move(from, to)` — `copy` then `delete`. Drivers override when
 *     the backend has a single-call equivalent (S3 `copyObject` +
 *     `deleteObject`, FS `rename`)
 *   - `close()` — default no-op
 *
 * All path arguments funnel through `normalizePath` (see `path.ts`)
 * before reaching the driver. The base handles the normalization;
 * driver overrides receive already-normalized strings.
 */

import { normalizePath } from './path.ts'
import type {
  ListOptions,
  ListResult,
  PutOptions,
  SignedUrlOptions,
  StorageStat,
  StorageWriteable,
} from './types.ts'

export class Storage {
  // ─── Primitives — subclass MUST override ─────────────────────────────────

  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  get(path: string): Promise<Uint8Array> {
    throw new Error('Storage.get must be overridden by the driver subclass.')
  }
  put(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
    path: string,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
    contents: StorageWriteable,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
    options?: PutOptions,
  ): Promise<void> {
    throw new Error('Storage.put must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  exists(path: string): Promise<boolean> {
    throw new Error('Storage.exists must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  stat(path: string): Promise<StorageStat> {
    throw new Error('Storage.stat must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  delete(path: string): Promise<boolean> {
    throw new Error('Storage.delete must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  copy(from: string, to: string): Promise<void> {
    throw new Error('Storage.copy must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  list(options?: ListOptions): Promise<ListResult> {
    throw new Error('Storage.list must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  publicUrl(path: string): string {
    throw new Error('Storage.publicUrl must be overridden by the driver subclass.')
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: subclass contract
  signedUrl(path: string, options: SignedUrlOptions): Promise<string> {
    throw new Error('Storage.signedUrl must be overridden by the driver subclass.')
  }

  // ─── Base-class compositions ─────────────────────────────────────────────

  /** UTF-8 decoded `get`. Drivers may override for efficiency. */
  async getString(path: string): Promise<string> {
    const bytes = await this.get(path)
    return new TextDecoder().decode(bytes)
  }

  /**
   * Stream a key's contents. The default implementation reads the
   * whole object via `get` and emits a single chunk — drivers that
   * have native streaming (LocalStorage via `Bun.file().stream()`,
   * S3 via `S3File.stream()`) should override.
   */
  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const bytes = await this.get(path)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  /**
   * `copy` then `delete`. Drivers with a server-side rename
   * (LocalStorage via `fs.rename`) override; the base fallback works
   * for every driver.
   */
  async move(from: string, to: string): Promise<void> {
    await this.copy(from, to)
    await this.delete(from)
  }

  /** Resource cleanup. Default no-op; S3Storage doesn't need teardown. */
  async close(): Promise<void> {}

  // ─── Internal helpers — drivers call into these ──────────────────────────

  /**
   * Validate + normalize a single path. Drivers wrap their entry
   * points via `this._normalize(path)` so the rejection happens
   * BEFORE any backend call — saves a round-trip on garbage input.
   */
  protected _normalize(path: string): string {
    return normalizePath(path)
  }
}
