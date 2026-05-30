/**
 * `SSEEvent` — one record on the wire of an `text/event-stream`
 * response. The shape follows the WHATWG EventSource spec:
 *
 *   data: hello
 *   event: tick
 *   id: 01J...
 *   retry: 2000
 *
 *   (blank line terminates one record)
 *
 * Field semantics:
 *   - `data` is mandatory. Strings are sent verbatim; non-string values
 *     are `JSON.stringify`'d so handlers can yield POJOs directly.
 *   - `event` is the named event channel — clients listen via
 *     `eventSource.addEventListener('tick', ...)`. Omit to send a
 *     default `message` event.
 *   - `id` flips on automatic `Last-Event-ID` tracking — the next
 *     reconnect attempt sends it back as a header so the server can
 *     replay missed events.
 *   - `retry` overrides the client's reconnection delay (ms).
 *   - `comment` writes a `: comment\n` line; used for keep-alive pings
 *     that traverse proxies that buffer empty SSE responses.
 */

export interface SSEEvent {
  data?: unknown
  event?: string
  id?: string
  retry?: number
  comment?: string
}
