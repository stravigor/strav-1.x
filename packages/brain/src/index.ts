// Public API of @strav/brain.
//
// V1: Provider interface + AnthropicProvider, BrainManager, Thread,
// BrainProvider service-wiring, prompt caching.
// V2 (this slice): tools + agents — defineTool, Agent base + AgentRunner,
// BrainManager.runTools / .agent(Class), Provider.runWithTools.
// Still deferred: MCP, embeddings, streaming agent loops, server-side
// tools, structured outputs, other providers.

export { Agent } from './agent.ts'
export type { AgentGenerateResult } from './agent_generate_result.ts'
export type { AgentResult } from './agent_result.ts'
export { AgentRunner, type AgentRunResult } from './agent_runner.ts'
export type { AgentStreamEvent } from './agent_stream_event.ts'
export {
  type AnthropicProviderConfig,
  type BrainCacheConfig,
  type BrainConfigShape,
  type DeepSeekProviderConfig,
  DEFAULT_MODEL,
  DEFAULT_TIERS,
  type GeminiProviderConfig,
  type OllamaProviderConfig,
  type OpenAIProviderConfig,
  type ProviderConfig,
} from './brain_config.ts'
export { BrainError } from './brain_error.ts'
export {
  type AgentResolver,
  BrainManager,
  type BrainManagerOptions,
} from './brain_manager.ts'
export { BrainProvider } from './brain_provider.ts'
export { defineTool, type DefineToolSpec } from './define_tool.ts'
export type { MCPServer, MCPServerToolConfig } from './mcp_server.ts'
export type { OutputSchema } from './output_schema.ts'
export { AnthropicProvider } from './providers/anthropic_provider.ts'
export { DeepSeekProvider } from './providers/deepseek_provider.ts'
export { GeminiProvider } from './providers/gemini_provider.ts'
export { OllamaProvider } from './providers/ollama_provider.ts'
export { OpenAICompatProvider } from './providers/openai_compat_provider.ts'
export { OpenAIProvider } from './providers/openai_provider.ts'
export type { Provider, RunWithToolsOptions } from './provider.ts'
export { Thread, type ThreadOptions, type ThreadState } from './thread.ts'
export type { Tool, ToolContext } from './tool.ts'
export { ToolExecutionError } from './tool_execution_error.ts'
export type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  AudioBlock,
  AudioSource,
  DocumentBlock,
  EmbedOptions,
  EmbedResult,
  GenerateResult,
  ImageBlock,
  MCPToolResultBlock,
  MCPToolUseBlock,
  Message,
  ModelTier,
  ServerTool,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscribeOptions,
  TranscribeResult,
} from './types.ts'
