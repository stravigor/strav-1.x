/**
 * Daily-rotating file destination.
 *
 * For a configured base path `storage/logs/app.log`, this writes to
 * `storage/logs/app-YYYY-MM-DD.log` and rolls over at midnight UTC when the
 * next log line lands on a new day. Files older than `days` are deleted at
 * destination construction (best-effort — failure to prune does not throw).
 *
 * Rotation strategy intentionally simple: no in-process timers, no fsync
 * dance. Suitable for low-to-mid volume. Apps with serious throughput should
 * lean on the OS (logrotate) or a syslog channel instead.
 */

import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  type Stats,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { LogDestination } from './destination.ts'

export interface DailyDestinationOptions {
  /**
   * Base path. The date is inserted before the extension:
   * `app.log` → `app-2026-05-27.log`.
   */
  path: string
  /** Retain this many days of historical files. Default `14`. */
  days?: number
  /** Override the clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

export function dailyDestination(options: DailyDestinationOptions): LogDestination {
  const basePath = isAbsolute(options.path) ? options.path : resolve(process.cwd(), options.path)
  const dir = dirname(basePath)
  const ext = extname(basePath)
  const stem = basename(basePath, ext)
  const days = options.days ?? 14
  const now = options.now ?? Date.now

  mkdirSync(dir, { recursive: true })
  pruneOldFiles(dir, stem, ext, days, now)

  let currentDate = formatDate(now())
  let currentStream: WriteStream = openFile(dir, stem, ext, currentDate)

  return {
    write(line: string): void {
      const today = formatDate(now())
      if (today !== currentDate) {
        currentStream.end()
        currentDate = today
        currentStream = openFile(dir, stem, ext, currentDate)
        pruneOldFiles(dir, stem, ext, days, now)
      }
      currentStream.write(line)
    },
    close(): Promise<void> {
      return new Promise((resolveClose) => {
        currentStream.end(() => resolveClose())
      })
    },
  }
}

function openFile(dir: string, stem: string, ext: string, date: string): WriteStream {
  const path = join(dir, `${stem}-${date}${ext}`)
  return createWriteStream(path, { flags: 'a' })
}

function formatDate(timestampMs: number): string {
  const d = new Date(timestampMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function pruneOldFiles(
  dir: string,
  stem: string,
  ext: string,
  days: number,
  now: () => number,
): void {
  if (days <= 0) return
  const cutoff = now() - days * 24 * 60 * 60 * 1000
  const prefix = `${stem}-`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(ext)) continue
    const path = join(dir, entry)
    let stat: Stats
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.mtimeMs < cutoff) {
      try {
        unlinkSync(path)
      } catch {
        // Best-effort prune — ignore failures (permissions, race, etc.)
      }
    }
  }
}
