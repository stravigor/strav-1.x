import { describe, expect, test } from 'bun:test'
import { DatabaseNotificationDriver } from '../../../src/drivers/database/database_notification_driver.ts'
import type {
  NotificationRepository,
  RecordInput,
} from '../../../src/drivers/database/notification_repository.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'
import { NotificationDeliveryError } from '../../../src/notification_error.ts'

class InvoicePaid extends BaseNotification {
  override via(): readonly string[] {
    return ['database']
  }
  toDatabase(_n: Notifiable): Record<string, unknown> {
    return { invoiceId: 'inv_42', amount: 4900, currency: 'thb' }
  }
}

class MailOnly extends BaseNotification {
  override via(): readonly string[] {
    return ['database']
  }
}

const alice: Notifiable = { id: 'u_1', notifiableType: 'User' }
const context = { id: 'n_db_1', dispatchedAt: new Date() }

/**
 * Build a `NotificationRepository` test double. The driver only ever
 * calls `repository.record({...})`; the rest of the Repository surface
 * doesn't need to exist.
 */
function buildRepository(): {
  repository: NotificationRepository
  recorded: RecordInput[]
} {
  const recorded: RecordInput[] = []
  const fake = {
    record: async (input: RecordInput) => {
      recorded.push(input)
      return { id: input.id } as never
    },
  }
  return { repository: fake as unknown as NotificationRepository, recorded }
}

describe('DatabaseNotificationDriver', () => {
  test('persists the toDatabase payload through NotificationRepository.record', async () => {
    const { repository, recorded } = buildRepository()
    const driver = new DatabaseNotificationDriver({ name: 'database', repository })
    const result = await driver.send(alice, new InvoicePaid(), context)
    expect(result).toEqual({
      channel: 'database',
      delivered: true,
      reference: 'n_db_1',
    })
    expect(recorded.length).toBe(1)
    expect(recorded[0]).toMatchObject({
      id: 'n_db_1',
      type: 'InvoicePaid',
      data: { invoiceId: 'inv_42', amount: 4900, currency: 'thb' },
    })
    expect(recorded[0]?.notifiable.id).toBe('u_1')
  })

  test('returns delivered: false when notification has no toDatabase hook', async () => {
    const { repository, recorded } = buildRepository()
    const driver = new DatabaseNotificationDriver({ name: 'database', repository })
    const result = await driver.send(alice, new MailOnly(), context)
    expect(result).toEqual({ channel: 'database', delivered: false })
    expect(recorded.length).toBe(0)
  })

  test('wraps repository failures in NotificationDeliveryError', async () => {
    const repository = {
      record: async () => {
        throw new Error('FK violation: notifiable_id')
      },
    } as unknown as NotificationRepository
    const driver = new DatabaseNotificationDriver({ name: 'database', repository })
    let caught: unknown
    try {
      await driver.send(alice, new InvoicePaid(), context)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as Error).message).toContain('persist failed')
  })
})
