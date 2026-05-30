// Public API of @strav/brain.
//
// Shipped:
//   - `BrainDriver` contract + concrete drivers — Anthropic, OpenAI
//     (Chat + Responses), Gemini, DeepSeek, Ollama, openai-compat.
//   - `BrainManager` + `Thread` (persisted history, compaction) + the
//     `BrainProvider` service wiring + prompt-cache plumbing.
//   - Tools — `defineTool`, `Agent` base + `AgentRunner`,
//     `runWithTools` + `streamWithTools` (agentic + streaming loops).
//   - Structured outputs — `generate`, `runWithToolsAndSchema`,
//     `streamWithToolsAndSchema` (JSON-Schema constrained replies).
//   - MCP — server-side (Anthropic) + local client (`@strav/brain/mcp`).
//   - Embeddings (`embed`), audio transcription (`transcribe`),
//     human-in-the-loop suspend/resume.

export { Agent } from './agent.ts'
export type { AgentGenerateResult } from './agent_generate_result.ts'
export type { AgentResult } from './agent_result.ts'
export {
  AgentRunner,
  type AgentRunMaybeSuspended,
  type AgentRunResult,
} from './agent_runner.ts'
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
  type OpenAIResponsesProviderConfig,
  type ProviderConfig,
} from './brain_config.ts'
export {
  BrainConfigError,
  BrainError,
  BrainProviderError,
  BrainUsageError,
  UnknownProviderError,
} from './brain_error.ts'
export {
  type AgentResolver,
  BrainManager,
  type BrainManagerOptions,
} from './brain_manager.ts'
export { BrainProvider } from './brain_provider.ts'
export { defineTool, type DefineToolSpec } from './define_tool.ts'
export { MCPClientPool, type MCPClientFactory } from './mcp/pool.ts'
export type { MCPServer, MCPServerToolConfig } from './mcp_server.ts'
export type { OutputSchema } from './output_schema.ts'
export { AnthropicBrainDriver } from './drivers/anthropic/anthropic_brain_driver.ts'
export { DeepSeekBrainDriver } from './drivers/deepseek/deepseek_brain_driver.ts'
export { GeminiBrainDriver } from './drivers/gemini/gemini_brain_driver.ts'
export { OllamaBrainDriver } from './drivers/ollama/ollama_brain_driver.ts'
export { OpenAICompatBrainDriver } from './drivers/openai_compat/openai_compat_brain_driver.ts'
export { OpenAIBrainDriver } from './drivers/openai/openai_brain_driver.ts'
export { OpenAIResponsesBrainDriver } from './drivers/openai_responses/openai_responses_brain_driver.ts'
export type {
  BrainDriver,
  RunWithToolsOptions,
  RunWithToolsOptionsWithSuspend,
} from './brain_driver.ts'
export {
  appendResumeResults,
  isSuspended,
  type SuspendedRun,
  type SuspendedState,
  type ToolResultInput,
} from './suspended_run.ts'
export { Thread, type ThreadOptions, type ThreadState } from './thread.ts'
export type { Tool, ToolContext } from './tool.ts'
export { ToolExecutionError } from './tool_execution_error.ts'
export type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  CompactConfig,
  CompactionBlock,
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
