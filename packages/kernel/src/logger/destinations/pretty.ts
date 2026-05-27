/**
 * Tiny pretty-printer used by the `stderr` channel when `pretty: true`.
 *
 * Aimed at local-dev readability — color-free, single-line per event, with
 * the structured fields appended after the message. We avoid pulling in
 * `pino-pretty` so the kernel stays Pino-only at install time.
 */

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
}

const SUPPRESSED = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v'])

export function formatPretty(event: Record<string, unknown>): string {
  const level = typeof event.level === 'number' ? (LEVEL_NAMES[event.level] ?? '?') : '?'
  const time = formatTime(event.time)
  const msg = typeof event.msg === 'string' ? event.msg : ''

  const extras: string[] = []
  for (const [key, value] of Object.entries(event)) {
    if (SUPPRESSED.has(key)) continue
    extras.push(`${key}=${stringify(value)}`)
  }

  const tail = extras.length > 0 ? ` ${extras.join(' ')}` : ''
  return `${time} ${level.padEnd(5)} ${msg}${tail}`
}

function formatTime(time: unknown): string {
  if (typeof time === 'number') return new Date(time).toISOString()
  if (typeof time === 'string') return time
  return new Date().toISOString()
}

function stringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return /\s/.test(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
