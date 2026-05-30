/**
 * Wrap an `AsyncIterable<SSEEvent>` into an HTTP `Response` with the
 * correct `text/event-stream` framing.
 *
 *   - `content-type: text/event-stream; charset=utf-8` — required.
 *   - `cache-control: no-cache, no-transform` — keeps reverse proxies
 *     from buffering and gzipping the stream.
 *   - `connection: keep-alive` — explicit; helps over HTTP/1.1.
 *   - `x-accel-buffering: no` — disables nginx response buffering.
 *
 * Heartbeats — apps wire SSE through intermediaries (nginx, CDNs) that
 * close idle connections silently. The wrapper sends a `: heartbeat`
 * comment line every `heartbeatMs` (default 15s) so the connection
 * stays alive and proxies don't close it. Set `heartbeatMs: 0` to
 * disable.
 *
 * Abort handling — when the client disconnects, the `Request.signal`
 * aborts. The wrapper calls the iterable's `return()` so generators
 * run their `finally` blocks and broadcast subscriptions release
 * their drivers.
 */

import { encodeSSEEvent } from './encode_sse_event.ts'
import type { SSEEvent } from './sse_event.ts'

export interface SSEResponseOptions {
  /** Heartbeat interval in ms. `0` disables. Default `15000`. */
  heartbeatMs?: number
  /**
   * Pre-attach the client's `AbortSignal` so the iterator's `return()`
   * runs when the client disconnects. Pass `ctx.request.raw.signal`.
   */
  signal?: AbortSignal
  /** Additional response headers merged onto the SSE defaults. */
  headers?: Record<string, string> | Headers
}

export function sseResponse(
  iterable: AsyncIterable<SSEEvent>,
  options: SSEResponseOptions = {},
): Response {
  const heartbeatMs = options.heartbeatMs ?? 15_000

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let iterator: AsyncIterator<SSEEvent> | undefined
  let aborted = false

  const close = async (): Promise<void> => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    if (iterator !== undefined && iterator.return !== undefined) {
      try {
        await iterator.return(undefined)
      } catch {
        // Iterator's finally already ran or rejected — nothing more we
        // can do from the response side.
      }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      iterator = iterable[Symbol.asyncIterator]()

      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (aborted) return
          try {
            controller.enqueue(encodeSSEEvent({ comment: 'heartbeat' }))
          } catch {
            // Controller already closed — the abort path will tidy up.
          }
        }, heartbeatMs)
        heartbeatTimer.unref?.()
      }

      if (options.signal !== undefined) {
        const onAbort = (): void => {
          aborted = true
          try {
            controller.close()
          } catch {
            // Already closed.
          }
          void close()
        }
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done) break
          if (aborted) break
          controller.enqueue(encodeSSEEvent(next.value))
        }
      } catch (err) {
        if (!aborted) controller.error(err)
        await close()
        return
      }
      if (!aborted) controller.close()
      await close()
    },
    async cancel() {
      aborted = true
      await close()
    },
  })

  const headers = new Headers(options.headers)
  headers.set('content-type', 'text/event-stream; charset=utf-8')
  headers.set('cache-control', 'no-cache, no-transform')
  headers.set('connection', 'keep-alive')
  headers.set('x-accel-buffering', 'no')

  return new Response(stream, { status: 200, headers })
}
