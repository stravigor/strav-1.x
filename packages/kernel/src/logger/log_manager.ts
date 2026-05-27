/**
 * `LogManager` — builds and caches one `Logger` per configured channel.
 *
 * Built once at boot from `config('logger')`. Validates the config eagerly so
 * misconfiguration surfaces during provider boot, not at the first log call.
 * Each channel's destination is constructed lazily on first `channel(name)`,
 * then cached for the lifetime of the manager.
 *
 * `shutdown()` flushes and closes every destination opened so far.
 */

import pino from 'pino'
import { ConfigError } from '../exceptions/config_error.ts'
import { dailyDestination } from './destinations/daily_destination.ts'
import type { LogDestination } from './destinations/destination.ts'
import { singleDestination } from './destinations/single_destination.ts'
import { stackDestination } from './destinations/stack_destination.ts'
import { stderrDestination } from './destinations/stderr_destination.ts'
import { syslogDestination } from './destinations/syslog_destination.ts'
import { Logger } from './logger.ts'
import { compileRedactor, type Redactor } from './redact.ts'
import type { ChannelConfig, LoggerConfig, LogLevel } from './types.ts'

interface BuiltChannel {
  logger: Logger
  destination: LogDestination
}

export class LogManager {
  private readonly redactor: Redactor
  private readonly channelCache = new Map<string, BuiltChannel>()
  private readonly openDestinations = new Set<LogDestination>()

  constructor(private readonly config: LoggerConfig) {
    this.validate(config)
    this.redactor = compileRedactor(config.redact)
  }

  /** The default channel — equivalent to `channel(config.default)`. */
  default(): Logger {
    return this.channel(this.config.default)
  }

  /** Resolve (and cache) a channel by name. */
  channel(name: string): Logger {
    const cached = this.channelCache.get(name)
    if (cached) return cached.logger
    const built = this.buildChannel(name, new Set())
    this.channelCache.set(name, built)
    return built.logger
  }

  /** Flush and close every destination that has been opened. */
  async shutdown(): Promise<void> {
    const open = [...this.openDestinations]
    this.openDestinations.clear()
    this.channelCache.clear()
    await Promise.all(
      open.map(async (dest) => {
        if (dest.close) {
          try {
            await dest.close()
          } catch {
            // Best-effort: never throw during shutdown.
          }
        }
      }),
    )
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private buildChannel(name: string, visiting: Set<string>): BuiltChannel {
    const channelConfig = this.config.channels[name]
    if (!channelConfig) {
      throw new ConfigError(`Logger: channel "${name}" is not defined in config.`)
    }
    if (visiting.has(name)) {
      throw new ConfigError(
        `Logger: stack channel "${[...visiting, name].join(' → ')}" forms a cycle.`,
      )
    }
    visiting.add(name)
    const destination = this.buildDestination(name, channelConfig, visiting)
    visiting.delete(name)

    this.openDestinations.add(destination)

    const level = channelConfig.level ?? this.config.level
    const pinoInstance = pino(
      {
        level,
        serializers: {
          err: pino.stdSerializers.err,
          error: pino.stdSerializers.err,
        },
      },
      destination,
    )
    const logger = new Logger(pinoInstance, this.redactor, this)
    return { logger, destination }
  }

  private buildDestination(
    name: string,
    cfg: ChannelConfig,
    visiting: Set<string>,
  ): LogDestination {
    switch (cfg.driver) {
      case 'stderr':
        return stderrDestination({ pretty: cfg.pretty })
      case 'single':
        return singleDestination({ path: cfg.path })
      case 'daily':
        return dailyDestination({ path: cfg.path, days: cfg.days })
      case 'syslog':
        return syslogDestination()
      case 'stack': {
        if (cfg.children.length === 0) {
          throw new ConfigError(`Logger: stack channel "${name}" has no children.`)
        }
        const childDestinations = cfg.children.map((child) => {
          // Reuse already-built children so a single destination is shared.
          const cached = this.channelCache.get(child)
          if (cached) return cached.destination
          const built = this.buildChannel(child, visiting)
          this.channelCache.set(child, built)
          return built.destination
        })
        return stackDestination(childDestinations)
      }
    }
  }

  private validate(config: LoggerConfig): void {
    if (!config.channels[config.default]) {
      throw new ConfigError(
        `Logger: default channel "${config.default}" is not defined in channels.`,
      )
    }
    for (const [name, channel] of Object.entries(config.channels)) {
      if (channel.driver === 'stack') {
        for (const child of channel.children) {
          if (!config.channels[child]) {
            throw new ConfigError(
              `Logger: stack channel "${name}" references undefined child "${child}".`,
            )
          }
        }
      }
      if (channel.level !== undefined) assertLevel(name, channel.level)
    }
    assertLevel('default', config.level)
  }
}

function assertLevel(context: string, level: LogLevel): void {
  const valid: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
  if (!valid.includes(level)) {
    throw new ConfigError(`Logger: invalid level "${level}" for ${context}.`)
  }
}
