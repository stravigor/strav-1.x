/**
 * `ArrayTransport` — in-memory mail sink for tests.
 *
 * Records every `send()` in insertion order. Apps wire it as the
 * default transport during tests, then assert on `transport.messages`
 * to verify what would have left the process. No I/O, no encoding —
 * the recorded `Message` is the same object passed to `send()` (a
 * shallow copy, so downstream mutation by the caller doesn't disturb
 * recorded history).
 */

import type { Message } from '../message.ts'
import type { Transport } from '../transport.ts'

export class ArrayTransport implements Transport {
  private readonly _messages: Message[] = []

  async send(message: Message): Promise<void> {
    this._messages.push({ ...message })
  }

  /** Frozen view of every message recorded since the last `clear()`. */
  get messages(): readonly Message[] {
    return this._messages
  }

  /** Number of messages recorded. Equivalent to `messages.length`. */
  get count(): number {
    return this._messages.length
  }

  /** Drop all recorded messages. Use between tests. */
  clear(): void {
    this._messages.length = 0
  }
}
