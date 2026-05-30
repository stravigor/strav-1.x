import { describe, expect, test } from 'bun:test'
import { BrainManager } from '@strav/brain'
import { Application, ConfigProvider, LoggerProvider } from '@strav/kernel'
import { stubBrainProvider } from '../../src/brain/stub_brain_provider.ts'

describe('stubBrainProvider', () => {
  test('registers a BrainManager whose embed maps the user fn over inputs', async () => {
    const app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: { default: 'main', level: 'silent', channels: { main: { driver: 'stderr' } } },
      }),
      new LoggerProvider(),
      stubBrainProvider({
        embed: (text) => [text.length, 0, 0, 0],
        model: 'len-embed',
      }),
    ])
    await app.start({ signalHandlers: false })

    const brain = app.resolve(BrainManager)
    const result = await brain.embed(['hi', 'hello'])
    expect(result.embeddings).toEqual([
      [2, 0, 0, 0],
      [5, 0, 0, 0],
    ])
    expect(result.model).toBe('len-embed')

    await app.shutdown()
  })

  test('defaults `model` to "stub" when not supplied', async () => {
    const app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: { default: 'main', level: 'silent', channels: { main: { driver: 'stderr' } } },
      }),
      new LoggerProvider(),
      stubBrainProvider({ embed: (_t) => [1] }),
    ])
    await app.start({ signalHandlers: false })
    const brain = app.resolve(BrainManager)
    const result = await brain.embed(['x'])
    expect(result.model).toBe('stub')
    await app.shutdown()
  })

  test('provider name is "brain" so dependents resolve correctly', () => {
    const provider = stubBrainProvider({ embed: (_t) => [0] })
    expect(provider.name).toBe('brain')
    expect(provider.dependencies).toEqual(['config'])
  })
})
