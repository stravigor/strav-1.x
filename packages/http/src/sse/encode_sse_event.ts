/**
 * Encode a `SSEEvent` into its wire bytes. Multi-line `data` is
 * emitted as one `data:` line per source line — required by the
 * WHATWG spec; without it, clients receive truncated payloads.
 * Non-string `data` is `JSON.stringify`'d for convenience.
 */

import type { SSEEvent } from './sse_event.ts'

const ENCODER = new TextEncoder()

export function encodeSSEEvent(event: SSEEvent): Uint8Array {
  let out = ''
  if (event.comment !== undefined) {
    out += `: ${event.comment}\n`
  }
  if (event.event !== undefined) {
    out += `event: ${event.event}\n`
  }
  if (event.id !== undefined) {
    out += `id: ${event.id}\n`
  }
  if (event.retry !== undefined) {
    out += `retry: ${event.retry}\n`
  }
  if (event.data !== undefined) {
    const text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
    for (const line of text.split('\n')) {
      out += `data: ${line}\n`
    }
  }
  // Records terminate with a blank line. Even an all-comment ping is
  // valid SSE — it just doesn't fire a JS event on the client.
  out += '\n'
  return ENCODER.encode(out)
}
