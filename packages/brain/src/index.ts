// Public API of @strav/brain.
//
// V1: Provider interface + AnthropicProvider, BrainManager, Thread,
// BrainProvider service-wiring, prompt caching.
// V2 (this slice): tools + agents — defineTool, Agent base + AgentRunner,
// BrainManager.runTools / .agent(Class), Provider.runWithTools.
// Still deferred: MCP, embeddings, streaming agent loops, server-side
// tools, structured outputs, other providers.

export { Agent } from './agent.ts'
export type { AgentResult } from './agent_result.ts'
export { AgentRunner } from './agent_runner.ts'
export {
  type AnthropicProviderConfig,
  type BrainCacheConfig,
  type BrainConfigShape,
  DEFAULT_MODEL,
  DEFAULT_TIERS,
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
export { AnthropicProvider } from './providers/anthropic_provider.ts'
export type { Provider, RunWithToolsOptions } from './provider.ts'
export { Thread, type ThreadOptions, type ThreadState } from './thread.ts'
export type { Tool, ToolContext } from './tool.ts'
export { ToolExecutionError } from './tool_execution_error.ts'
export type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ContentBlock,
  MCPToolResultBlock,
  MCPToolUseBlock,
  Message,
  ModelTier,
  StreamEvent,
  SystemPrompt,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './types.ts'
