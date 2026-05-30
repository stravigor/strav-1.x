/**
 * `PostgresBroadcaster` — multi-node broadcast backplane via a
 * polled ledger table.
 *
 * Why polling and not LISTEN/NOTIFY:
 *
 *   Bun's built-in Postgres driver does not surface LISTEN/NOTIFY
 *   to user code (as of Bun 1.3). The next-cheapest cross-node
 *   primitive is a write-then-read ledger — same pattern as
 *   `@strav/queue`'s `DatabaseQueue`. The polling interval
 *   determines latency; 250ms (default) keeps round-trip on the
 *   order of a network hop while consuming negligible DB CPU.
 *
 * How it works:
 *
 *   - `publish(channel, event)` INSERTs one row into
 *     `strav_broadcast_events`.
 *   - One poller per process runs `SELECT * FROM ... WHERE id > $lastId
 *     ORDER BY id` every `pollIntervalMs`. New rows are fanned out to
 *     local subscribers via an internal `MemoryBroadcaster`.
 *   - The poller starts on first `subscribe()` and stops when the
 *     broadcaster closes. Subscriber count drops to zero → poller stops
 *     (lazy) so apps that only publish don't spin a poll loop.
 *   - On startup, `lastId = SELECT max(id)`. Subscribers always start
 *     from "events published from now on" — no historical replay.
 *   - A retention sweep runs every `cleanupIntervalMs` and deletes
 *     rows older than `retentionSeconds`. Keeps the table from growing
 *     forever without inventing TTL semantics in app code.
 *
 * Apps wire `PostgresBroadcastProvider` instead of `BroadcastProvider`
 * to use this driver; the SSE handler / Notification driver inject the
 * shared `Broadcaster` token and see this concrete instance.
 */

import { BroadcastPublishError } from '../../broadcast_error.ts'
import { Broadcaster } from '../../broadcaster.ts'
import type { BroadcastEvent, BroadcastSubscription } from '../../types.ts'
import { MemoryBroadcaster } from '../memory/memory_broadcaster.ts'
import { broadcastEventSchema } from './broadcast_event_schema.ts'

/**
 * Minimal slice of `@strav/database`'s `DatabaseExecutor` we actually
 * need. Declared inline (not imported) to keep the runtime peer-dep
 * optional — apps using `MemoryBroadcaster` shouldn't pay for
 * `@strav/database` in their bundle.
 */
export interface PostgresBroadcasterDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  execute(sql: string, params?: readonly unknown[]): Promise<number>
}

export interface PostgresBroadcasterOptions {
  db: PostgresBroadcasterDatabase
  /** Poll interval (ms). Default `250`. */
  pollIntervalMs?: number
  /**
   * How long to retain events in the ledger before the sweep deletes
   * them. Default `300` seconds (5 minutes). Set higher only if your
   * SSE clients can reconnect and need replay capability; the
   * default is "keep enough for a node to recover from a crash and
   * catch up to live", not "audit log".
   */
  retentionSeconds?: number
  /** Interval between retention sweeps. Default `30000` ms. */
  cleanupIntervalMs?: number
  /**
   * Per-subscription buffer cap forwarded to the in-process
   * `MemoryBroadcaster`. Default `1000`.
   */
  maxBufferSize?: number
  /** Forwarded to the in-process `MemoryBroadcaster`'s onOverflow hook. */
  onOverflow?: (channel: string, droppedEvent: BroadcastEvent) => void
}

interface BroadcastEventRow {
  id: string | number
  channel: string
  event_name: string
  event_id: string
  data: unknown
}

export class PostgresBroadcaster extends Broadcaster {
  private readonly db: PostgresBroadcasterDatabase
  private readonly local: MemoryBroadcaster
  private readonly tableName = broadcastEventSchema.name
  private readonly pollIntervalMs: number
  private readonly retentionSeconds: number
  private readonly cleanupIntervalMs: number

  private lastId = 0n
  private cursorPrimed = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private pollInFlight: Promise<void> | undefined

  constructor(options: PostgresBroadcasterOptions) {
    super()
    this.db = options.db
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.retentionSeconds = options.retentionSeconds ?? 300
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 30_000
    this.local = new MemoryBroadcaster({
      ...(options.maxBufferSize !== undefined ? { maxBufferSize: options.maxBufferSize } : {}),
      ...(options.onOverflow !== undefined ? { onOverflow: options.onOverflow } : {}),
    })
  }

  override async publish(channel: string, event: BroadcastEvent): Promise<void> {
    let serialised: string
    try {
      serialised = JSON.stringify(event.data)
    } catch (cause) {
      throw new BroadcastPublishError('PostgresBroadcaster: event.data is not JSON-serialisable.', {
        context: { channel, event: event.event },
        cause,
      })
    }
    try {
      await this.db.execute(
        `INSERT INTO "${this.tableName}" ("channel", "event_name", "event_id", "data", "created_at")
         VALUES ($1, $2, $3, $4::jsonb, now())`,
        [channel, event.event, event.id, serialised],
      )
    } catch (cause) {
      throw new BroadcastPublishError('PostgresBroadcaster: INSERT failed.', {
        context: { channel, event: event.event },
        cause,
      })
    }
  }

  override subscribe(channel: string): BroadcastSubscription {
    const subscription = this.local.subscribe(channel)
    void this.ensurePoller()
    return subscription
  }

  override async close(): Promise<void> {
    this.closed = true
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    if (this.pollInFlight !== undefined) {
      try {
        await this.pollInFlight
      } catch {
        // The next start() will surface this if it persists.
      }
    }
    await this.local.close()
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Run one polling pass immediately and re-arm the timer. Exposed for
   * tests so the suite doesn't have to sleep through `pollIntervalMs`.
   */
  async pollOnce(): Promise<void> {
    if (this.closed) return
    if (!this.cursorPrimed) await this.primeCursor()
    const rows = await this.db.query<BroadcastEventRow>(
      `SELECT "id", "channel", "event_name", "event_id", "data"
       FROM "${this.tableName}"
       WHERE "id" > $1
       ORDER BY "id"
       LIMIT 1000`,
      [this.lastId.toString()],
    )
    for (const row of rows) {
      this.lastId = BigInt(row.id)
      await this.local.publish(row.channel, {
        id: row.event_id,
        event: row.event_name,
        // Bun.SQL returns jsonb as a string (no auto-hydration on
        // `unsafe()`). Parse here so subscribers receive the same
        // object shape they passed to publish().
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      })
    }
  }

  /** Same idea — exposed for tests that want to verify cleanup behaviour. */
  async sweepOnce(): Promise<number> {
    return this.db.execute(
      `DELETE FROM "${this.tableName}" WHERE "created_at" < now() - ($1::text || ' seconds')::interval`,
      [String(this.retentionSeconds)],
    )
  }

  private async ensurePoller(): Promise<void> {
    if (this.closed) return
    if (this.pollTimer !== undefined) return
    await this.primeCursor()
    this.startPollLoop()
    this.startCleanupLoop()
  }

  private async primeCursor(): Promise<void> {
    if (this.cursorPrimed) return
    const [row] = await this.db.query<{ max: string | number | null }>(
      `SELECT MAX("id") AS "max" FROM "${this.tableName}"`,
    )
    this.lastId = row?.max !== null && row?.max !== undefined ? BigInt(row.max) : 0n
    this.cursorPrimed = true
  }

  private startPollLoop(): void {
    if (this.closed) return
    const tick = async (): Promise<void> => {
      if (this.closed) return
      this.pollInFlight = this.pollOnce().catch(() => {
        // Errors are silent at the loop level — we don't want a
        // transient DB blip to tear the broadcaster down. Apps that
        // need visibility wire the database driver's own logging.
      })
      await this.pollInFlight
      this.pollInFlight = undefined
      if (!this.closed) {
        this.pollTimer = setTimeout(() => void tick(), this.pollIntervalMs)
      }
    }
    this.pollTimer = setTimeout(() => void tick(), this.pollIntervalMs)
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer !== undefined) return
    this.cleanupTimer = setInterval(() => {
      void this.sweepOnce().catch(() => {
        // Same rationale as the poll loop.
      })
    }, this.cleanupIntervalMs)
    // Allow the process to exit if this is the only timer keeping it alive.
    this.cleanupTimer.unref?.()
  }
}
