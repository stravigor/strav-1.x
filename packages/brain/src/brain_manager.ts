/**
 * `BrainManager` — the per-app facade apps inject and call.
 *
 * Holds the configured `Provider` registry + the default-provider key
 * + the tier-to-model map. Apps call `chat / stream / countTokens`
 * with framework-native types; the manager resolves which provider
 * runs the call (default unless `options.provider` overrides),
 * applies tier sugar (`options.tier` → concrete `model`), and
 * delegates.
 *
 * Constructed by `BrainProvider` at boot from `config.brain`. Apps
 * also build one inline for tests:
 *
 * ```ts
 * const brain = new BrainManager({
 *   default: 'anthropic',
 *   providers: { anthropic: stubProvider },
 * })
 * ```
 */

import { BrainError } from './brain_error.ts'
import type { ModelTier } from './types.ts'
import type {
  ChatOptions,
  ChatResult,
  Message,
  StreamEvent,
} from './types.ts'
import type { Provider } from './provider.ts'
import { DEFAULT_TIERS } from './brain_config.ts'

export interface BrainManagerOptions {
  /** Name of the default provider — must exist in `providers`. */
  default: string
  /** Provider registry keyed by name. */
  providers: Record<string, Provider>
  /** Tier-to-model overrides; merged on top of the framework defaults. */
  tiers?: Partial<Record<ModelTier, string>>
  /** Default for `ChatOptions.cache` when the call site doesn't pass one. */
  defaultCache?: boolean
}

export class BrainManager {
  readonly defaultProvider: string
  private readonly providers: Map<string, Provider>
  private readonly tiers: Record<ModelTier, string>
  private readonly defaultCache: boolean

  constructor(options: BrainManagerOptions) {
    if (!options.providers[options.default]) {
      throw new BrainError(
        `BrainManager: default provider "${options.default}" is not registered.`,
        { context: { default: options.default, available: Object.keys(options.providers) } },
      )
    }
    this.defaultProvider = options.default
    this.providers = new Map(Object.entries(options.providers))
    this.tiers = { ...DEFAULT_TIERS, ...(options.tiers ?? {}) }
    this.defaultCache = options.defaultCache ?? false
  }

  /** Resolve a provider by name. Default when no name passed. Throws when unknown. */
  provider(name?: string): Provider {
    const key = name ?? this.defaultProvider
    const provider = this.providers.get(key)
    if (!provider) {
      throw new BrainError(`BrainManager: no provider registered under "${key}".`, {
        context: { requested: key, available: [...this.providers.keys()] },
      })
    }
    return provider
  }

  /**
   * One-shot chat: send the messages, await the full reply.
   *
   * Accepts either a bare prompt string (treated as a single
   * user-role message) or a typed `Message[]` for multi-turn /
   * pre-built conversations.
   */
  async chat(input: string | readonly Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return this.provider(options.provider).chat(messages, resolved)
  }

  /**
   * Stream the reply. Yields a `text` event per delta and a single
   * terminal `stop` event with usage + stop-reason. Apps that want
   * just the final message use `chat()` instead — this surface is
   * for UI streaming.
   */
  stream(
    input: string | readonly Message[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return this.provider(options.provider).stream(messages, resolved)
  }

  /**
   * Count input tokens for the given messages + options. Returns
   * `null` when the configured provider doesn't expose a token count
   * helper (no `countTokens` method) — apps can fall back to a local
   * estimator at the call site.
   */
  async countTokens(
    input: string | readonly Message[],
    options: ChatOptions = {},
  ): Promise<number | null> {
    const provider = this.provider(options.provider)
    if (!provider.countTokens) return null
    const messages = normalizeInput(input)
    const resolved = this.applyDefaults(options)
    return provider.countTokens(messages, resolved)
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private applyDefaults(options: ChatOptions): ChatOptions {
    const resolved: ChatOptions = { ...options }
    if (resolved.model === undefined && resolved.tier !== undefined) {
      resolved.model = this.tiers[resolved.tier]
    }
    if (resolved.cache === undefined && this.defaultCache) {
      resolved.cache = true
    }
    return resolved
  }
}

function normalizeInput(input: string | readonly Message[]): readonly Message[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  return input
}
