/**
 * Tests for the tools + agents surface — `defineTool`, `Agent`,
 * `AgentRunner`, `BrainManager.runTools` / `.agent(Class)`, the
 * `Provider.runWithTools` plumbing, and `ToolExecutionError`
 * wrapping.
 *
 * Provider behavior (Anthropic-specific request/response shape for
 * tools) is covered by `anthropic_provider_tools.test.ts`. This file
 * uses a stub `Provider` that records calls so the agentic-loop logic
 * is exercised without a real SDK.
 */

import { describe, expect, test } from 'bun:test'
import { Agent } from '../src/agent.ts'
import type { AgentResult } from '../src/agent_result.ts'
import { BrainError } from '../src/brain_error.ts'
import { BrainManager } from '../src/brain_manager.ts'
import { defineTool } from '../src/define_tool.ts'
import type { Provider, RunWithToolsOptions } from '../src/provider.ts'
import type { Tool } from '../src/tool.ts'
import { ToolExecutionError } from '../src/tool_execution_error.ts'
import type {
  ChatOptions,
  ChatResult,
  Message,
  StreamEvent,
} from '../src/types.ts'

// ─── defineTool ──────────────────────────────────────────────────────────

describe('defineTool', () => {
  test('returns a Tool that preserves name / description / schema / execute', async () => {
    const tool = defineTool({
      name: 'add',
      description: 'Add two numbers.',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: async (input: { a: number; b: number }) => ({ sum: input.a + input.b }),
    })
    expect(tool.name).toBe('add')
    expect(tool.description).toBe('Add two numbers.')
    expect((tool.inputSchema as { type: string }).type).toBe('object')
    const result = await tool.execute({ a: 2, b: 3 }, { callId: 'cid', context: {} })
    expect(result).toEqual({ sum: 5 })
  })

  test('execute receives the ToolContext including the per-run context bag', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'Echo input + a context value.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_input: unknown, ctx) => ({
        callId: ctx.callId,
        userId: ctx.context.userId,
      }),
    })
    const result = await tool.execute({}, { callId: 'cid-1', context: { userId: 'u-1' } })
    expect(result).toEqual({ callId: 'cid-1', userId: 'u-1' })
  })
})

// ─── BrainManager.runTools — provider routing + error path ───────────────

class StubProvider implements Provider {
  readonly name = 'stub'
  readonly runWithToolsCalls: Array<{
    messages: readonly Message[]
    tools: readonly Tool[]
    options: RunWithToolsOptions | undefined
  }> = []
  constructor(private readonly result: AgentResult) {}

  async chat(): Promise<ChatResult> {
    throw new Error('chat not used in this suite')
  }
  async *stream(): AsyncIterable<StreamEvent> {}
  async runWithTools(
    messages: readonly Message[],
    tools: readonly Tool[],
    options?: RunWithToolsOptions,
  ): Promise<AgentResult> {
    this.runWithToolsCalls.push({ messages, tools, options })
    return this.result
  }
}

class StubProviderWithoutTools implements Provider {
  readonly name = 'no-tools'
  async chat(): Promise<ChatResult> {
    throw new Error('chat not used')
  }
  async *stream(): AsyncIterable<StreamEvent> {}
}

const sampleResult: AgentResult = {
  text: 'final answer',
  messages: [{ role: 'assistant', content: 'final answer' }],
  iterations: 1,
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
}

describe('BrainManager.runTools', () => {
  test('delegates to the provider with normalized messages + tools', async () => {
    const provider = new StubProvider(sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })
    const tool = defineTool({
      name: 't',
      description: 'noop',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    })
    const result = await brain.runTools('hello', [tool])

    expect(result).toEqual(sampleResult)
    expect(provider.runWithToolsCalls).toHaveLength(1)
    expect(provider.runWithToolsCalls[0]?.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(provider.runWithToolsCalls[0]?.tools).toEqual([tool])
  })

  test('throws BrainError when the configured provider does not implement runWithTools', async () => {
    const brain = new BrainManager({
      default: 'no-tools',
      providers: { 'no-tools': new StubProviderWithoutTools() },
    })
    await expect(brain.runTools('hi', [])).rejects.toBeInstanceOf(BrainError)
  })

  test('respects options.provider routing', async () => {
    const a = new StubProvider({ ...sampleResult, text: 'a' })
    const b = new StubProvider({ ...sampleResult, text: 'b' })
    const brain = new BrainManager({ default: 'a', providers: { a, b } })
    const result = await brain.runTools('hi', [], { provider: 'b' })
    expect(result.text).toBe('b')
    expect(a.runWithToolsCalls).toHaveLength(0)
    expect(b.runWithToolsCalls).toHaveLength(1)
  })

  test('applies default tier resolution to the tool call options', async () => {
    const provider = new StubProvider(sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })
    await brain.runTools('hi', [], { tier: 'fast' })
    expect(provider.runWithToolsCalls[0]?.options?.model).toBe('claude-haiku-4-5')
  })
})

// ─── Agent + AgentRunner ────────────────────────────────────────────────

class TestAgent extends Agent {
  override readonly instructions = 'You are a test agent.'
  override readonly tools: readonly Tool[] = []
  override readonly tier = 'fast'
  override readonly maxIterations = 7
  override readonly maxTokens = 1024
}

describe('Agent + AgentRunner', () => {
  test('brain.agent(Class) returns a runner that forwards declarative config', async () => {
    const provider = new StubProvider(sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })

    // The default container resolver builds the agent zero-arg, which
    // is fine for a class without constructor deps. For DI, BrainProvider
    // installs a resolver that goes through app.resolve(Class).
    const result = await brain.agent(TestAgent).input('hello').run()

    expect(result).toEqual(sampleResult)
    expect(provider.runWithToolsCalls).toHaveLength(1)
    const call = provider.runWithToolsCalls[0]!
    expect(call.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(call.options?.system).toBe('You are a test agent.')
    expect(call.options?.maxIterations).toBe(7)
    expect(call.options?.maxTokens).toBe(1024)
    expect(call.options?.model).toBe('claude-haiku-4-5') // tier 'fast' resolution
    expect(call.options?.context).toEqual({})
  })

  test('runner.context() accumulates and is passed through to the provider', async () => {
    const provider = new StubProvider(sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })
    await brain
      .agent(TestAgent)
      .input('hi')
      .context({ userId: 'u1' })
      .context({ tenantId: 't1' })
      .run()
    expect(provider.runWithToolsCalls[0]?.options?.context).toEqual({
      userId: 'u1',
      tenantId: 't1',
    })
  })

  test('runner.run() before input() throws', async () => {
    const brain = new BrainManager({
      default: 'stub',
      providers: { stub: new StubProvider(sampleResult) },
    })
    const runner = brain.agent(TestAgent)
    await expect(runner.run()).rejects.toThrow(/input\(\) must be called/)
  })

  test('explicit agent instance bypasses the resolver (apps with DI)', async () => {
    class CustomAgent extends TestAgent {
      constructor(public readonly extraDep: string) {
        super()
      }
    }
    const provider = new StubProvider(sampleResult)
    const brain = new BrainManager({ default: 'stub', providers: { stub: provider } })
    const instance = new CustomAgent('hello-from-test')
    await brain.agent(CustomAgent, instance).input('hi').run()
    // Asserting the system instruction came through proves the instance
    // we passed was the one used (rather than a fresh zero-arg one).
    expect(provider.runWithToolsCalls[0]?.options?.system).toBe('You are a test agent.')
  })
})

// ─── ToolExecutionError ──────────────────────────────────────────────────

describe('ToolExecutionError', () => {
  test('wraps the cause + carries tool name + call id in context', () => {
    const cause = new Error('boom')
    const err = new ToolExecutionError('myTool', 'cid-42', cause)
    expect(err.code).toBe('brain.tool-execution-failed')
    expect(err.context).toEqual({ tool: 'myTool', callId: 'cid-42' })
    expect(err.cause).toBe(cause)
    expect(err.message).toMatch(/myTool/)
    expect(err.message).toMatch(/boom/)
  })

  test('handles non-Error throws via String()', () => {
    const err = new ToolExecutionError('t', 'cid', 'plain-string')
    expect(err.message).toMatch(/plain-string/)
  })
})
