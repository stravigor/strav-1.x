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

import { ConfigError, type Container, type Logger, type LogManager } from '@strav/kernel'
import type { MailableClass, MailablePayloadOf } from './mailable.ts'
import type { MailRecipient, Message } from './message.ts'
import type { Transport } from './transport.ts'
import { AlibabaDmTransport } from './transports/alibaba_transport.ts'
import { ArrayTransport } from './transports/array_transport.ts'
import { LogTransport } from './transports/log_transport.ts'
import { MailgunTransport } from './transports/mailgun_transport.ts'
import { ResendTransport } from './transports/resend_transport.ts'
import { SendGridTransport } from './transports/sendgrid_transport.ts'

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

interface ResendTransportConfig {
  driver: 'resend'
  /** Resend API key. Pull from env in `config/mail.ts`; never hard-code. */
  apiKey: string
  /** Override the base URL — defaults to `https://api.resend.com`. */
  endpoint?: string
}

interface SendGridTransportConfig {
  driver: 'sendgrid'
  /** SendGrid API key. */
  apiKey: string
  /** Override the base URL — defaults to `https://api.sendgrid.com`. */
  endpoint?: string
}

interface MailgunTransportConfig {
  driver: 'mailgun'
  /** Mailgun API key. */
  apiKey: string
  /** Your Mailgun-verified sending domain (e.g. `mg.acme.com`). */
  domain: string
  /**
   * Override the base URL — defaults to `https://api.mailgun.net`.
   * Set to `https://api.eu.mailgun.net` for EU-region accounts.
   */
  endpoint?: string
}

interface AlibabaDmTransportConfig {
  driver: 'alibaba'
  /** Alibaba Cloud AccessKey ID. */
  accessKeyId: string
  /** Alibaba Cloud AccessKey Secret. */
  accessKeySecret: string
  /** Verified DirectMail sender account (set in the DM console). */
  accountName: string
  /**
   * Override the base URL — defaults to `https://dm.aliyuncs.com` (global).
   * SEA: `https://dm.ap-southeast-1.aliyuncs.com` (Singapore),
   * `https://dm.ap-southeast-3.aliyuncs.com` (Kuala Lumpur),
   * `https://dm.ap-southeast-5.aliyuncs.com` (Jakarta).
   */
  endpoint?: string
  /** Optional `TagName` attached to every send. */
  tagName?: string
  /** Enable DM click-tracking. Default false. */
  clickTrace?: boolean
}

/**
 * Discriminated union — every shipping driver gets an entry. Adding a
 * new driver here + a new `case` in `buildTransport` is the contract;
 * apps configure by string name.
 */
export type MailTransportConfig =
  | ArrayTransportConfig
  | LogTransportConfig
  | ResendTransportConfig
  | SendGridTransportConfig
  | MailgunTransportConfig
  | AlibabaDmTransportConfig

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
    /**
     * Optional `Container` used by the `send(MailableClass, payload)`
     * overload to construct mailables via `@inject()` reflection. Apps
     * that only ever call `send(message)` can omit it; the Mailable
     * overload throws a clear error if called without one wired.
     *
     * The `MailProvider` passes the resolving container automatically,
     * so apps using the provider don't pass anything by hand.
     */
    private readonly container?: Container,
  ) {
    this.validate(config)
  }

  /**
   * Send `message` via the default transport. Applies `config.mail.from`
   * if the message lacks one.
   */
  async send(message: Message): Promise<void>
  /**
   * Sync-send overload — constructs the `Mailable` subclass via the
   * container (so `@inject()` deps resolve), calls `build(payload)`,
   * then sends through the default transport. No queue hop; the
   * caller's process does the work.
   *
   * For async / retry / dead-letter semantics, dispatch through the
   * queue instead — `await queue.dispatch(WelcomeEmail, payload)`.
   * Mailables ARE Jobs, so the queue's `Worker` handles them with no
   * additional wiring beyond a `JobRegistry.register(WelcomeEmail)`.
   */
  async send<T extends MailableClass>(
    MailableClass: T,
    payload: MailablePayloadOf<T>,
  ): Promise<void>
  async send(arg1: Message | MailableClass, payload?: unknown): Promise<void> {
    if (typeof arg1 === 'function') {
      const message = await this.buildMailable(arg1, payload)
      await this.via().send(this.applyDefaultFrom(message))
      return
    }
    await this.via().send(this.applyDefaultFrom(arg1))
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

  private async buildMailable(MailableClass: MailableClass, payload: unknown): Promise<Message> {
    if (this.container === undefined) {
      throw new ConfigError(
        'MailManager: send(MailableClass, payload) requires a Container — wire MailProvider instead of constructing MailManager directly.',
      )
    }
    const mailable = this.container.make(MailableClass)
    return mailable.build(payload as never)
  }

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
      case 'resend':
        return new ResendTransport({ apiKey: cfg.apiKey, endpoint: cfg.endpoint })
      case 'sendgrid':
        return new SendGridTransport({ apiKey: cfg.apiKey, endpoint: cfg.endpoint })
      case 'mailgun':
        return new MailgunTransport({
          apiKey: cfg.apiKey,
          domain: cfg.domain,
          endpoint: cfg.endpoint,
        })
      case 'alibaba':
        return new AlibabaDmTransport({
          accessKeyId: cfg.accessKeyId,
          accessKeySecret: cfg.accessKeySecret,
          accountName: cfg.accountName,
          endpoint: cfg.endpoint,
          tagName: cfg.tagName,
          clickTrace: cfg.clickTrace,
        })
    }
  }

  private validate(config: MailConfig): void {
    if (config.transports[config.default] === undefined) {
      throw new ConfigError(
        `Mail: default transport "${config.default}" is not defined in transports.`,
      )
    }
    const knownDrivers = new Set(['array', 'log', 'resend', 'sendgrid', 'mailgun', 'alibaba'])
    for (const [name, cfg] of Object.entries(config.transports)) {
      if (!knownDrivers.has(cfg.driver)) {
        throw new ConfigError(
          `Mail: transport "${name}" has unknown driver "${(cfg as { driver: string }).driver}".`,
        )
      }
      if (
        (cfg.driver === 'resend' || cfg.driver === 'sendgrid' || cfg.driver === 'mailgun') &&
        !cfg.apiKey
      ) {
        throw new ConfigError(
          `Mail: transport "${name}" (${cfg.driver}) requires a non-empty \`apiKey\`.`,
        )
      }
      if (cfg.driver === 'mailgun' && !cfg.domain) {
        throw new ConfigError(
          `Mail: transport "${name}" (mailgun) requires a non-empty \`domain\`.`,
        )
      }
      if (cfg.driver === 'alibaba') {
        if (!cfg.accessKeyId || !cfg.accessKeySecret) {
          throw new ConfigError(
            `Mail: transport "${name}" (alibaba) requires \`accessKeyId\` and \`accessKeySecret\`.`,
          )
        }
        if (!cfg.accountName) {
          throw new ConfigError(
            `Mail: transport "${name}" (alibaba) requires \`accountName\` — the verified DirectMail sender.`,
          )
        }
      }
    }
  }
}
