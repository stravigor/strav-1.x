/**
 * Minimal Memcached text-protocol client over `Bun.connect`.
 *
 * Just enough surface to back `MemcachedCache`: `set` / `add` / `get`
 * / `delete` / `incr` / `decr` / `flush_all`. No SASL auth, no
 * pipelining, no consistent-hash routing — one TCP connection to one
 * server, serialized request stream.
 *
 * Requests are queued; the next request waits for the previous
 * response to land so the parser stays simple (response bytes can
 * only be matched against the head of the queue). Throughput at one
 * server is fine for cache workloads; if you outgrow it, an app
 * builds its own multi-conn wrapper or uses Redis.
 *
 * Bytes go through `TextEncoder` / `TextDecoder` — Memcached's text
 * protocol is single-byte ASCII for control lines but values are
 * binary-safe. The driver `JSON.stringify`s on the way in and is
 * tolerant of non-JSON strings on the way out (counters return
 * decimal strings).
 */

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export interface MemcachedClientOptions {
  host: string
  port: number
  /** Connection timeout in ms. Default `5000`. */
  connectTimeoutMs?: number
  /** Per-request response timeout in ms. Default `5000`. */
  requestTimeoutMs?: number
}

interface PendingRequest {
  // Lines we've collected so far (excluding the terminator).
  buffer: Uint8Array
  resolve: (response: Uint8Array) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

type Socket = Awaited<ReturnType<typeof Bun.connect>>

export class MemcachedClient {
  private readonly host: string
  private readonly port: number
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number

  private socket: Socket | undefined
  private connecting: Promise<Socket> | undefined
  private closed = false

  /** FIFO queue of (request → pending response). */
  private readonly queue: PendingRequest[] = []

  constructor(options: MemcachedClientOptions) {
    this.host = options.host
    this.port = options.port
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
  }

  async send(command: string | Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new Error('MemcachedClient: closed.')
    const socket = await this.connect()
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Pull this request from the queue when it times out so the
        // parser doesn't fire callbacks on a dead promise. Subsequent
        // responses still land on the next pending request.
        const idx = this.queue.findIndex((r) => r === pending)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(new Error(`MemcachedClient: request timed out after ${this.requestTimeoutMs}ms.`))
      }, this.requestTimeoutMs)
      const pending: PendingRequest = {
        buffer: new Uint8Array(0),
        resolve,
        reject,
        timer,
      }
      this.queue.push(pending)
      const payload = typeof command === 'string' ? ENCODER.encode(command) : command
      socket.write(payload)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const p of this.queue) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      p.reject(new Error('MemcachedClient: closed.'))
    }
    this.queue.length = 0
    if (this.socket !== undefined) {
      try {
        this.socket.end()
      } catch {
        // Already torn down.
      }
      this.socket = undefined
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async connect(): Promise<Socket> {
    if (this.socket !== undefined) return this.socket
    if (this.connecting !== undefined) return this.connecting
    this.connecting = this.openSocket()
    try {
      this.socket = await this.connecting
      return this.socket
    } finally {
      this.connecting = undefined
    }
  }

  private async openSocket(): Promise<Socket> {
    let resolveOpen: ((socket: Socket) => void) | undefined
    let rejectOpen: ((err: Error) => void) | undefined
    const opened = new Promise<Socket>((res, rej) => {
      resolveOpen = res
      rejectOpen = rej
    })
    const timeout = setTimeout(() => {
      rejectOpen?.(
        new Error(`MemcachedClient: connect timed out after ${this.connectTimeoutMs}ms.`),
      )
    }, this.connectTimeoutMs)

    const sock = await Bun.connect({
      hostname: this.host,
      port: this.port,
      socket: {
        open: (socket) => {
          clearTimeout(timeout)
          resolveOpen?.(socket as Socket)
        },
        data: (_socket, chunk) => {
          // Bun typings model the chunk as Buffer; downstream code
          // uses Uint8Array operations only, so the cast is safe.
          this.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        },
        error: (_socket, err) => {
          this.failQueue(err)
        },
        close: () => {
          this.failQueue(new Error('MemcachedClient: socket closed.'))
          this.socket = undefined
        },
      },
    })
    return opened.catch((err) => {
      try {
        sock.end()
      } catch {
        // ignore
      }
      throw err
    })
  }

  /**
   * Append chunk to the head-of-queue request and check whether the
   * accumulated buffer now represents a complete reply. Replies end on
   * one of the protocol's terminator lines:
   *
   *   - `END\r\n` (after a `get` / `gets` block)
   *   - `STORED\r\n` / `NOT_STORED\r\n` / `EXISTS\r\n` (storage commands)
   *   - `DELETED\r\n` / `NOT_FOUND\r\n` / `TOUCHED\r\n`
   *   - `OK\r\n` (flush_all, version)
   *   - a single decimal line (incr/decr — `12345\r\n`)
   *   - `CLIENT_ERROR <msg>\r\n` / `SERVER_ERROR <msg>\r\n` / `ERROR\r\n`
   */
  private onData(chunk: Uint8Array): void {
    while (chunk.length > 0) {
      const pending = this.queue[0]
      if (pending === undefined) {
        // Stray bytes after a queue purge — drop them.
        return
      }
      const merged = new Uint8Array(pending.buffer.length + chunk.length)
      merged.set(pending.buffer)
      merged.set(chunk, pending.buffer.length)
      pending.buffer = merged
      const text = DECODER.decode(pending.buffer)
      const end = findReplyEnd(text)
      if (end === -1) {
        // Need more bytes — exit and wait.
        return
      }
      const replyText = text.slice(0, end)
      const replyBytes = ENCODER.encode(replyText)
      const leftoverText = text.slice(end)
      this.queue.shift()
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.resolve(replyBytes)
      chunk = ENCODER.encode(leftoverText)
    }
  }

  private failQueue(err: Error): void {
    for (const p of this.queue) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      p.reject(err)
    }
    this.queue.length = 0
  }
}

/**
 * Locate the end-of-reply boundary in the text-form accumulated buffer.
 * Returns the index *after* the terminator. `-1` if the reply is
 * incomplete.
 */
function findReplyEnd(text: string): number {
  // Multi-line `get` reply ends with `END\r\n` on its own line. Scan
  // for that first — the response may have any number of `VALUE` /
  // data lines before it.
  const endMarker = '\r\nEND\r\n'
  const endIdx = text.indexOf(endMarker)
  if (endIdx >= 0) return endIdx + endMarker.length

  // Replies that ARE just `END\r\n` (empty get) — the buffer starts
  // with it.
  if (text.startsWith('END\r\n')) return 'END\r\n'.length

  // Single-line replies — find the first CRLF and check the line.
  const firstCrlf = text.indexOf('\r\n')
  if (firstCrlf === -1) return -1
  const firstLine = text.slice(0, firstCrlf)
  if (SINGLE_LINE_REPLIES.has(firstLine)) return firstCrlf + 2
  if (firstLine.startsWith('CLIENT_ERROR ')) return firstCrlf + 2
  if (firstLine.startsWith('SERVER_ERROR ')) return firstCrlf + 2
  if (firstLine.startsWith('VERSION ')) return firstCrlf + 2
  // incr/decr return a bare decimal value.
  if (/^\d+$/.test(firstLine)) return firstCrlf + 2
  return -1
}

const SINGLE_LINE_REPLIES = new Set([
  'STORED',
  'NOT_STORED',
  'EXISTS',
  'DELETED',
  'NOT_FOUND',
  'TOUCHED',
  'OK',
  'ERROR',
])
