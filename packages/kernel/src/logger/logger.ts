/**
 * `Logger` — the public façade every Strav consumer interacts with.
 *
 * Backed by Pino but the surface is deliberately thinner:
 *   - Levels are method calls (`trace` / `debug` / `info` / `warn` / `error` / `fatal`).
 *   - The first arg is the event identifier (`msg`), the second is structured fields.
 *   - `child(context)` returns a logger pre-bound to extra fields (request-scope
 *     correlation, etc.).
 *   - `channel(name)` switches to a different channel (when a `LogManager` is
 *     wired into this logger; standalone loggers throw `ConfigError`).
 *
 * Redaction is applied to the fields object *before* it is handed to Pino, so
 * no channel ever sees the raw value.
 *
 * @see docs/kernel/guides/logger.md
 * @see spec/errors-and-logging.md
 */

import type pino from 'pino'
import { ConfigError } from '../exceptions/config_error.ts'
import type { Redactor } from './redact.ts'
import type { LogFields, LogLevel } from './types.ts'

/**
 * The slice of `LogManager` that `Logger.channel()` needs. Defined as an
 * interface to keep the two files from import-cycling.
 */
export interface ChannelResolver {
  channel(name: string): Logger
}

export class Logger {
  constructor(
    private readonly pinoInstance: pino.Logger,
    private readonly redactor: Redactor,
    private readonly manager?: ChannelResolver,
  ) {}

  trace(msg: string, fields?: LogFields): void {
    this.emit('trace', msg, fields)
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields)
  }

  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields)
  }

  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields)
  }

  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields)
  }

  fatal(msg: string, fields?: LogFields): void {
    this.emit('fatal', msg, fields)
  }

  /**
   * Emit at a dynamic level. `silent` is a no-op (parity with Pino's level set).
   * Useful when the level comes from data, e.g. mapping an upstream severity.
   */
  log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (level === 'silent') return
    this.emit(level, msg, fields)
  }

  /**
   * Return a child logger pre-bound to `context`. Fields merge with anything
   * the child later passes per-call; the parent is unaffected.
   */
  child(context: LogFields): Logger {
    const redacted = this.redactor(context)
    return new Logger(this.pinoInstance.child(redacted), this.redactor, this.manager)
  }

  /** Resolve a different channel by name. Requires a `LogManager` to be wired. */
  channel(name: string): Logger {
    if (!this.manager) {
      throw new ConfigError(
        `Logger: cannot resolve channel "${name}" — this logger was constructed without a LogManager.`,
      )
    }
    return this.manager.channel(name)
  }

  /** Lowest-level escape hatch — exposed primarily for tests / advanced wiring. */
  get raw(): pino.Logger {
    return this.pinoInstance
  }

  private emit(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void {
    if (fields === undefined) {
      this.pinoInstance[level](msg)
      return
    }
    const safe = this.redactor(fields)
    this.pinoInstance[level](safe, msg)
  }
}
