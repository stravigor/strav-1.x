// Public API of @strav/brain.
//
// Foundation slice: Provider interface + AnthropicProvider, BrainManager,
// Thread, BrainProvider service-wiring, prompt caching. Tools / agents /
// MCP / embeddings / other providers (OpenAI/Google/DeepSeek) land in
// follow-up slices.

export {
  type AnthropicProviderConfig,
  type BrainCacheConfig,
  type BrainConfigShape,
  DEFAULT_MODEL,
  DEFAULT_TIERS,
  type ProviderConfig,
} from './brain_config.ts'
export { BrainError } from './brain_error.ts'
export { BrainManager, type BrainManagerOptions } from './brain_manager.ts'
export { BrainProvider } from './brain_provider.ts'
export { AnthropicProvider } from './providers/anthropic_provider.ts'
export type { Provider } from './provider.ts'
export { Thread, type ThreadOptions, type ThreadState } from './thread.ts'
export type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  Message,
  ModelTier,
  StreamEvent,
  SystemPrompt,
  TextBlock,
} from './types.ts'
