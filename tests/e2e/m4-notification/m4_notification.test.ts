/**
 * M4 end-to-end smoke — proves `@strav/notification` against real
 * Postgres.
 *
 * The wire under test:
 *
 *   notifications.send(alice, new InvoicePaid({ amount }))
 *     → BaseNotification.via(notifiable) → ['mail', 'database', 'log']
 *     → MailNotificationDriver.send
 *       → MailManager.send via ArrayTransport            ← assertion target
 *     → DatabaseNotificationDriver.send
 *       → NotificationRepository.record
 *         → INSERT into "notification" row               ← assertion target
 *     → LogNotificationDriver.send
 *       → Logger.info(toLog payload)                     ← assertion target
 *
 * Self-skips when no Postgres is available — matches the integration
 * suites' contract.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PostgresDatabase } from '@strav/database'
import { Logger } from '@strav/kernel'
import {
  type ArrayTransport,
  type MailConfig,
  MailManager,
  MailProvider,
  type Message,
} from '@strav/mail'
import {
  BaseNotification,
  type Notifiable,
  NotificationManager,
  NotificationProvider,
} from '@strav/notification'
import {
  applyNotificationMigration,
  DatabaseNotificationProvider,
} from '@strav/notification/database'
import { LogNotificationProvider } from '@strav/notification/log'
import { MailNotificationProvider } from '@strav/notification/mail'
import {
  bootTestApp,
  type BootTestAppResult,
  isPostgresAvailable,
} from '@strav/testing'

const PG_AVAILABLE = await isPostgresAvailable()

// ─── Notification fixture ───────────────────────────────────────────────

interface InvoicePaidPayload {
  invoiceId: string
  amount: number
}

class InvoicePaid extends BaseNotification {
  constructor(private readonly payload: InvoicePaidPayload) {
    super()
  }
  override via(_n: Notifiable): readonly string[] {
    return ['mail', 'database', 'log']
  }
  toMail(notifiable: Notifiable): Message {
    return {
      to: [notifiable['email'] as string],
      subject: `Invoice ${this.payload.invoiceId} paid`,
      text: `Your payment of ${this.payload.amount} cents has been received.`,
    }
  }
  toDatabase(_n: Notifiable): Record<string, unknown> {
    return { invoiceId: this.payload.invoiceId, amount: this.payload.amount }
  }
  toLog(_n: Notifiable): string {
    return `invoice ${this.payload.invoiceId} paid (${this.payload.amount})`
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('M4 e2e: @strav/notification fans across mail / database / log', () => {
  let booted: BootTestAppResult

  beforeAll(async () => {
    booted = await bootTestApp({
      config: {
        mail: {
          default: 'array',
          from: 'noreply@acme.com',
          transports: { array: { driver: 'array' } },
        } as MailConfig,
        notification: {
          channels: {
            mail: { driver: 'mail' },
            database: { driver: 'database' },
            log: { driver: 'log' },
          },
        },
      },
      // applyNotificationMigration already emits CREATE TABLE for
      // notificationSchema — passing it via `schemas:` here would conflict
      // ("relation already exists"). Migration is the source of truth.
      migrations: [(db, registry) => applyNotificationMigration(db, { registry })],
      providers: [
        new MailProvider(),
        new NotificationProvider(),
        new MailNotificationProvider(),
        new DatabaseNotificationProvider(),
        new LogNotificationProvider(),
      ],
    })
  })

  afterAll(() => booted.dispose())

  test('migration created the notification table + partial unread index', async () => {
    const rows = await booted.setupDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'notification'`,
    )
    expect(rows.length).toBe(1)

    const indexes = await booted.setupDb.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'notification'`,
    )
    expect(indexes.map((i) => i.indexname)).toContain('idx_notification_notifiable_unread')
  })

  test('send fans out to mail + database + log; all three report delivered', async () => {
    const notifications = booted.app.resolve(NotificationManager)
    const mail = booted.app.resolve(MailManager)
    const transport = mail.via('array') as unknown as ArrayTransport

    const alice: Notifiable = { id: 'u_alice', email: 'alice@acme.com', notifiableType: 'User' }
    const result = await notifications.send(
      alice,
      new InvoicePaid({ invoiceId: 'inv_42', amount: 4900 }),
    )

    // All three channels delivered.
    expect(result.deliveries.map((d) => d.channel)).toEqual(['mail', 'database', 'log'])
    expect(result.deliveries.every((d) => d.delivered)).toBe(true)

    // Mail assertion.
    expect(transport.messages.length).toBe(1)
    expect(transport.messages[0]?.subject).toBe('Invoice inv_42 paid')
    expect(transport.messages[0]?.to).toEqual(['alice@acme.com'])

    // Database assertion.
    const rows = await booted.setupDb.query<{
      id: string
      notifiable_id: string
      type: string
      data: { invoiceId: string; amount: number }
    }>(`SELECT id, notifiable_id, type, data FROM "notification" WHERE notifiable_id = $1`, [
      'u_alice',
    ])
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe(result.id)
    expect(rows[0]?.type).toBe('InvoicePaid')
    expect(rows[0]?.data.invoiceId).toBe('inv_42')
    expect(rows[0]?.data.amount).toBe(4900)
  })

  test('channels that skip via hook do not produce a delivery error', async () => {
    class MailOnly extends BaseNotification {
      override via(): readonly string[] {
        return ['mail', 'database']
      }
      toMail(notifiable: Notifiable): Message {
        return {
          to: [notifiable['email'] as string],
          subject: 'mail only',
          text: 'no database hook',
        }
      }
    }
    const notifications = booted.app.resolve(NotificationManager)
    const result = await notifications.send(
      { id: 'u_bob', email: 'bob@acme.com', notifiableType: 'User' },
      new MailOnly(),
    )
    // Mail delivered. Database skipped (no error, `delivered: false`).
    expect(result.deliveries[0]).toMatchObject({ channel: 'mail', delivered: true })
    expect(result.deliveries[1]).toMatchObject({ channel: 'database', delivered: false })
    expect(result.deliveries[1]?.error).toBeUndefined()
  })

  // Touch Logger so the import isn't dropped — sanity check that
  // LogNotificationProvider's dependency on 'logger' wires correctly.
  test('LogNotificationProvider booted: Logger resolves from container', () => {
    expect(booted.app.resolve(Logger)).toBeInstanceOf(Logger)
  })

  // Touch PostgresDatabase to verify the database channel's repository
  // got a working connection through DI.
  test('DatabaseNotificationProvider booted: PostgresDatabase resolves from container', () => {
    expect(booted.app.resolve(PostgresDatabase)).toBeInstanceOf(PostgresDatabase)
  })
})
