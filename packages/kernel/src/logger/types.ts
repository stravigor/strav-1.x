/**
 * Public types for the logger subsystem.
 *
 * `LoggerConfig` is the shape the `config/logger.ts` file produces. `LogLevel`
 * mirrors Pino's level set, plus `silent` for "disable this channel". Channel
 * configs are a discriminated union keyed by `driver`.
 *
 * @see docs/kernel/guides/logger.md
 * @see spec/errors-and-logging.md
 */

/** Severity levels — ordered low (chatty) to high (urgent). `silent` suppresses everything. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/** Structured fields attached to a log line (or a child logger). */
export type LogFields = Record<string, unknown>

// ─── Channel configs (discriminated by `driver`) ──────────────────────────────

export interface StackChannelConfig {
  driver: 'stack'
  /** Child channel names to fan out to. */
  children: readonly string[]
  level?: LogLevel
}

export interface StderrChannelConfig {
  driver: 'stderr'
  /** Pretty-print JSON lines for local development. JSON is the default. */
  pretty?: boolean
  level?: LogLevel
}

export interface SingleChannelConfig {
  driver: 'single'
  /** Filesystem path, absolute or relative to cwd. */
  path: string
  level?: LogLevel
}

export interface DailyChannelConfig {
  driver: 'daily'
  /** Base path; the date suffix is inserted before the extension. */
  path: string
  /** Retention window in days. Older rotated files are deleted at boot. */
  days?: number
  level?: LogLevel
}

export interface SyslogChannelConfig {
  driver: 'syslog'
  host?: string
  port?: number
  level?: LogLevel
}

export type ChannelConfig =
  | StackChannelConfig
  | StderrChannelConfig
  | SingleChannelConfig
  | DailyChannelConfig
  | SyslogChannelConfig

// ─── Top-level logger config ──────────────────────────────────────────────────

export interface RedactConfig {
  /**
   * Path expressions to redact. Supports:
   *   - `password`            — exact top-level field
   *   - `headers.authorization` — exact nested path
   *   - `*.password`          — single wildcard segment
   *   - `**.token`            — recursive wildcard (any depth)
   */
  paths?: readonly string[]
  /** Replacement value. Default `'[REDACTED]'`. */
  censor?: string
}

export interface LoggerConfig {
  /** Name of the channel resolved by `logger.info(...)` (no `channel()` call). */
  default: string
  /** Default level for all channels. May be overridden per-channel. */
  level: LogLevel
  /** Channel registry, keyed by name. */
  channels: Record<string, ChannelConfig>
  /** Redaction applied before any log line is written. */
  redact?: RedactConfig
}
