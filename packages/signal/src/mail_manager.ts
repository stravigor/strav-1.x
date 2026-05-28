/**
 * `MailManager` — builds and caches one `Transport` per configured
 * mail transport.
 *
 * Built once at boot from `config('mail')`. Validates the config eagerly
 * (default-transport exists, every entry has a known `driver`) so
 * misconfiguration surfaces during provider boot, not on the first
 * `mail.send()` call inside a request. Each transport's underlying
 * resource is constructed lazily on first `via(name)`, then cached for
 * the lifetime of the manager.
 *
 * The `from` substitution
 *   `config.mail.from` is an optional default sender. If a `Message`
 *   omits `from`, the manager fills it in before handing the message
 *   to the transport. If neither is set, the transport throws. The
 *   manager does NOT override a `from` the caller already set —
 *   per-message overrides win.
 *
 * Shutdown
 *   `shutdown()` runs every cached transport's optional `close()`
 *   best-effort, swallowing errors so a misbehaving transport can't
 *   block app shutdown.
 *
 * Multi-transport apps
 *   `via(name?)` returns a named transport (or the default if `name`
 *   is omitted). Callers that want to route a particular message
 *   through a non-default transport do:
 *
 *     await mail.via('priority').send({ to, subject, ... })
 */

import { ConfigError, type Logger, type LogManager } from '@strav/kernel'
import type { MailRecipient, Message } from './message.ts'
import type { Transport } from './transport.ts'
import { ArrayTransport } from './transports/array_transport.ts'
import { LogTransport } from './transports/log_transport.ts'

/** Per-driver transport config shapes. */
interface ArrayTransportConfig {
  driver: 'array'
}

interface LogTransportConfig {
  driver: 'log'
  /**
   * Logger channel to write to. Falls back to the default channel when
   * omitted. Apps typically dedicate a channel (`'mail'`) so dev output
   * is filterable.
   */
  channel?: string
  /** Default `'info'`. */
  level?: 'debug' | 'info'
  /** See `LogTransportOptions.includeBody`. Default `false`. */
  includeBody?: boolean
}

/**
 * Discriminated union — every shipping driver gets an entry. Adding a
 * new driver here + a new `case` in `buildTransport` is the contract;
 * apps configure by string name.
 */
export type MailTransportConfig = ArrayTransportConfig | LogTransportConfig

export interface MailConfig {
  /**
   * Name of the transport used by `send()` when the caller doesn't
   * specify one. Must be a key of `transports`.
   */
  default: string
  /**
   * Default `from` filled in when a `Message` omits one. Optional —
   * apps that always pass `from` per-message can leave this off.
   */
  from?: MailRecipient
  /** Transport instances keyed by name. */
  transports: Record<string, MailTransportConfig>
}

export class MailManager {
  private readonly cache = new Map<string, Transport>()

  constructor(
    private readonly config: MailConfig,
    private readonly logManager: LogManager,
  ) {
    this.validate(config)
  }

  /**
   * Send `message` via the default transport. Applies `config.mail.from`
   * if the message lacks one.
   */
  async send(message: Message): Promise<void> {
    await this.via().send(this.applyDefaultFrom(message))
  }

  /**
   * Resolve a transport by name. Pass nothing to get the default.
   * Returned transport is cached — subsequent calls return the same
   * instance.
   */
  via(name?: string): Transport {
    const key = name ?? this.config.default
    const cached = this.cache.get(key)
    if (cached) return cached
    const built = this.buildTransport(key)
    this.cache.set(key, built)
    return built
  }

  /**
   * Close every cached transport. Best-effort — individual transport
   * `close()` errors are swallowed so a misbehaving driver can't block
   * shutdown.
   */
  async shutdown(): Promise<void> {
    const open = [...this.cache.values()]
    this.cache.clear()
    await Promise.all(
      open.map(async (t) => {
        if (t.close === undefined) return
        try {
          await t.close()
        } catch {
          // Best-effort: never throw during shutdown.
        }
      }),
    )
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private applyDefaultFrom(message: Message): Message {
    if (message.from !== undefined) return message
    if (this.config.from === undefined) return message
    return { ...message, from: this.config.from }
  }

  private buildTransport(name: string): Transport {
    const cfg = this.config.transports[name]
    if (cfg === undefined) {
      throw new ConfigError(`Mail: transport "${name}" is not defined in config.`)
    }
    switch (cfg.driver) {
      case 'array':
        return new ArrayTransport()
      case 'log': {
        const logger: Logger =
          cfg.channel !== undefined
            ? this.logManager.channel(cfg.channel)
            : this.logManager.default()
        return new LogTransport({
          logger,
          level: cfg.level,
          includeBody: cfg.includeBody,
        })
      }
    }
  }

  private validate(config: MailConfig): void {
    if (config.transports[config.default] === undefined) {
      throw new ConfigError(
        `Mail: default transport "${config.default}" is not defined in transports.`,
      )
    }
    for (const [name, cfg] of Object.entries(config.transports)) {
      if (cfg.driver !== 'array' && cfg.driver !== 'log') {
        throw new ConfigError(
          `Mail: transport "${name}" has unknown driver "${(cfg as { driver: string }).driver}".`,
        )
      }
    }
  }
}
