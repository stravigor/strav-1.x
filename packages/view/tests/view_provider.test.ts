import { describe, expect, test } from 'bun:test'
import { Application, ConfigProvider } from '@strav/kernel'
import { ViewEngine, ViewProvider } from '../src/index.ts'

describe('ViewProvider', () => {
  test('binds ViewEngine + "view" alias from config.view', async () => {
    const app = new Application()
    app.useProviders([
      new ConfigProvider({ view: { directory: '/tmp/views', cache: true } }),
      new ViewProvider(),
    ])
    await app.start({ signalHandlers: false })
    try {
      const engine = app.resolve(ViewEngine)
      const alias = app.resolve<ViewEngine>('view')
      expect(alias).toBe(engine)
    } finally {
      await app.shutdown()
    }
  })

  test('omitting config.view uses defaults (no boot error)', async () => {
    const app = new Application()
    app.useProviders([new ConfigProvider({}), new ViewProvider()])
    await app.start({ signalHandlers: false })
    try {
      expect(app.resolve(ViewEngine)).toBeInstanceOf(ViewEngine)
    } finally {
      await app.shutdown()
    }
  })
})
