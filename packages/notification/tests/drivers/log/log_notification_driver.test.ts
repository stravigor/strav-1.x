import { describe, expect, test } from 'bun:test'
import type { Logger } from '@strav/kernel'
import { LogNotificationDriver } from '../../../src/drivers/log/log_notification_driver.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'

interface CapturedLog {
  level: string
  msg: string
  fields?: Record<string, unknown>
}

/**
 * Stub `Logger`. The driver only ever calls `.info(...)` / `.warn(...)`
 * / `.error(...)`, so the real pino-backed implementation isn't needed
 * here. Confine the cast to one place.
 */
function buildLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = []
  const make = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    logs.push({ level, msg, ...(fields ? { fields } : {}) })
  }
  const stub = { info: make('info'), warn: make('warn'), error: make('error') }
  return { logger: stub as unknown as Logger, logs }
}

class WelcomeWithLog extends BaseNotification {
  override via(): readonly string[] {
    return ['log']
  }
  toLog(_n: Notifiable): string {
    return 'welcome to alice'
  }
}

class WelcomeNoHook extends BaseNotification {
  override via(): readonly string[] {
    return ['log']
  }
}

class WelcomeStructured extends BaseNotification {
  override via(): readonly string[] {
    return ['log']
  }
  toLog(_n: Notifiable): Record<string, unknown> {
    return { action: 'signup', plan: 'free' }
  }
}

const alice: Notifiable = { id: 'u_1', email: 'a@b.co' }
const context = { id: 'n_test_1', dispatchedAt: new Date() }

describe('LogNotificationDriver', () => {
  test('writes the toLog string at info by default', async () => {
    const { logger, logs } = buildLogger()
    const driver = new LogNotificationDriver({ name: 'log', logger })
    const result = await driver.send(alice, new WelcomeWithLog(), context)
    expect(result).toEqual({ channel: 'log', delivered: true, reference: 'n_test_1' })
    expect(logs.length).toBe(1)
    expect(logs[0]?.level).toBe('info')
    expect(logs[0]?.msg).toBe('welcome to alice')
    expect(logs[0]?.fields).toMatchObject({
      'notification.id': 'n_test_1',
      'notification.type': 'WelcomeWithLog',
      'notification.channel': 'log',
      'notifiable.id': 'u_1',
    })
  })

  test('falls back to a generic message when no toLog hook', async () => {
    const { logger, logs } = buildLogger()
    const driver = new LogNotificationDriver({ name: 'log', logger })
    await driver.send(alice, new WelcomeNoHook(), context)
    expect(logs[0]?.msg).toContain('WelcomeNoHook')
    expect(logs[0]?.msg).toContain('log')
  })

  test('merges structured payload into log fields', async () => {
    const { logger, logs } = buildLogger()
    const driver = new LogNotificationDriver({ name: 'log', logger })
    await driver.send(alice, new WelcomeStructured(), context)
    expect(logs[0]?.fields).toMatchObject({
      'notification.id': 'n_test_1',
      action: 'signup',
      plan: 'free',
    })
  })

  test('honors the configured level', async () => {
    const { logger, logs } = buildLogger()
    const driver = new LogNotificationDriver({ name: 'log', logger, level: 'warn' })
    await driver.send(alice, new WelcomeWithLog(), context)
    expect(logs[0]?.level).toBe('warn')
  })
})
