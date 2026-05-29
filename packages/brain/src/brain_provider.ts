/**
 * `BrainProvider` — `ServiceProvider` that wires `BrainManager` into
 * the container from `config.brain`.
 *
 * Reads the brain config at register time, instantiates every
 * configured provider (today: just Anthropic), and binds a
 * `BrainManager` singleton. Apps inject it the standard way:
 *
 * ```ts
 * @inject()
 * class GreetingService {
 *   constructor(private readonly brain: BrainManager) {}
 *
 *   async greet(name: string): Promise<string> {
 *     const { text } = await this.brain.chat(`Greet ${name} warmly.`)
 *     return text
 *   }
 * }
 * ```
 *
 * Eager construction is on purpose — a missing API key or unknown
 * driver should fail at boot, not at the first call. The `boot()`
 * step resolves the manager so `ConfigError`s surface before any
 * request hits.
 */

import { type Application, ConfigError, ConfigRepository, ServiceProvider } from '@strav/kernel'
import { BrainManager } from './brain_manager.ts'
import type { BrainConfigShape, ProviderConfig } from './brain_config.ts'
import { AnthropicProvider } from './providers/anthropic_provider.ts'
import { DeepSeekProvider } from './providers/deepseek_provider.ts'
import { GeminiProvider } from './providers/gemini_provider.ts'
import { OllamaProvider } from './providers/ollama_provider.ts'
import { OpenAIProvider } from './providers/openai_provider.ts'
import { OpenAIResponsesProvider } from './providers/openai_responses_provider.ts'
import type { Provider } from './provider.ts'

export class BrainProvider extends ServiceProvider {
  override readonly name = 'brain'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(BrainManager, (c) => {
      const config = c.resolve(ConfigRepository).get('brain') as BrainConfigShape | undefined
      if (!config) {
        throw new ConfigError(
          'BrainProvider: `config.brain` is missing. Add a `config/brain.ts` with at least `default` + `providers`.',
        )
      }
      if (!config.providers || Object.keys(config.providers).length === 0) {
        throw new ConfigError(
          'BrainProvider: `config.brain.providers` must have at least one entry.',
        )
      }
      if (!config.providers[config.default]) {
        throw new ConfigError(
          `BrainProvider: default provider "${config.default}" is not declared in config.brain.providers.`,
        )
      }

      const providers: Record<string, Provider> = {}
      for (const [name, entry] of Object.entries(config.providers)) {
        providers[name] = buildProvider(name, entry)
      }

      const options: ConstructorParameters<typeof BrainManager>[0] = {
        default: config.default,
        providers,
      }
      if (config.tiers !== undefined) options.tiers = config.tiers
      if (config.cache?.auto !== undefined) options.defaultCache = config.cache.auto
      if (config.mcpServers !== undefined) options.defaultMcpServers = config.mcpServers
      const manager = new BrainManager(options)
      // Plug in the container so `brain.agent(MyAgent)` resolves
      // its constructor deps through `@inject()` like every other
      // injected class. The variance widening at the boundary
      // (`never[]` ↔ `any[]`) is purely a TS typing artifact — the
      // container call is identical to a direct `c.resolve(MyAgent)`.
      manager.setAgentResolver(<A>(cls: new (...args: never[]) => A) =>
        c.resolve(cls as unknown as new (...args: unknown[]) => A),
      )
      return manager
    })
  }

  override boot(app: Application): void {
    // Force-resolve so config errors surface at boot, not on first call.
    app.resolve(BrainManager)
  }
}

function buildProvider(name: string, config: ProviderConfig): Provider {
  switch (config.driver) {
    case 'anthropic':
      if (!config.apiKey) {
        throw new ConfigError(
          `BrainProvider: anthropic provider "${name}" is missing apiKey. Source from env('ANTHROPIC_API_KEY').`,
        )
      }
      return new AnthropicProvider(name, config)
    case 'openai':
      if (!config.apiKey) {
        throw new ConfigError(
          `BrainProvider: openai provider "${name}" is missing apiKey. Source from env('OPENAI_API_KEY').`,
        )
      }
      return new OpenAIProvider(name, config)
    case 'openai-responses':
      if (!config.apiKey) {
        throw new ConfigError(
          `BrainProvider: openai-responses provider "${name}" is missing apiKey. Source from env('OPENAI_API_KEY').`,
        )
      }
      return new OpenAIResponsesProvider(name, config)
    case 'google':
      if (!config.apiKey) {
        throw new ConfigError(
          `BrainProvider: google provider "${name}" is missing apiKey. Source from env('GOOGLE_API_KEY').`,
        )
      }
      return new GeminiProvider(name, config)
    case 'deepseek':
      if (!config.apiKey) {
        throw new ConfigError(
          `BrainProvider: deepseek provider "${name}" is missing apiKey. Source from env('DEEPSEEK_API_KEY').`,
        )
      }
      return new DeepSeekProvider(name, config)
    case 'ollama':
      if (!config.defaultModel) {
        throw new ConfigError(
          `BrainProvider: ollama provider "${name}" is missing defaultModel. Ollama models are user-installed — pick one you've pulled (e.g. 'llama3.2').`,
        )
      }
      return new OllamaProvider(name, config)
    default: {
      const exhaustiveCheck: never = config
      throw new ConfigError(
        `BrainProvider: unknown driver for provider "${name}". Known drivers: anthropic, openai, openai-responses, google, deepseek, ollama.`,
      )
      // (unreachable — kept for the exhaustive check to fire when a new driver lands)
      // biome-ignore lint/correctness/noUnreachable: kept for the exhaustive-check above
      return exhaustiveCheck
    }
  }
}
