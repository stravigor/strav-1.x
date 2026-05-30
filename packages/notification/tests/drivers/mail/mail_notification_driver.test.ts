import { describe, expect, test } from 'bun:test'
import { ArrayTransport, type MailManager, type Message } from '@strav/mail'
import { MailNotificationDriver } from '../../../src/drivers/mail/mail_notification_driver.ts'
import type { Notifiable } from '../../../src/notifiable.ts'
import { BaseNotification } from '../../../src/notification.ts'
import { NotificationDeliveryError } from '../../../src/notification_error.ts'

class WelcomeEmail extends BaseNotification {
  override via(): readonly string[] {
    return ['mail']
  }
  toMail(notifiable: Notifiable): Message {
    return {
      to: [notifiable['email'] as string],
      subject: 'Welcome',
      text: `Hi ${notifiable.id}`,
    }
  }
}

class SmsOnly extends BaseNotification {
  override via(): readonly string[] {
    return ['mail']
  }
  // intentionally no toMail
}

const alice: Notifiable = { id: 'u_1', email: 'a@b.co' }
const context = { id: 'n_1', dispatchedAt: new Date() }

/**
 * Build a `MailManager` test double. We only need `.send(message)` to
 * round-trip into an `ArrayTransport`-style recorder.
 */
function buildMail(): { mail: MailManager; sent: readonly Message[] } {
  const transport = new ArrayTransport()
  const fakeMail = {
    send: async (m: Message) => {
      await transport.send(m)
    },
  }
  return { mail: fakeMail as unknown as MailManager, sent: transport.messages }
}

describe('MailNotificationDriver', () => {
  test('reads toMail and dispatches via MailManager.send', async () => {
    const { mail, sent } = buildMail()
    const driver = new MailNotificationDriver({ name: 'mail', mail })
    const result = await driver.send(alice, new WelcomeEmail(), context)
    expect(result).toEqual({ channel: 'mail', delivered: true, reference: 'n_1' })
    expect(sent.length).toBe(1)
    expect(sent[0]?.subject).toBe('Welcome')
    expect(sent[0]?.to).toEqual(['a@b.co'])
  })

  test('returns delivered: false when notification has no toMail hook', async () => {
    const { mail, sent } = buildMail()
    const driver = new MailNotificationDriver({ name: 'mail', mail })
    const result = await driver.send(alice, new SmsOnly(), context)
    expect(result).toEqual({ channel: 'mail', delivered: false })
    expect(sent.length).toBe(0)
  })

  test('wraps upstream send failures in NotificationDeliveryError', async () => {
    const mail = {
      send: async () => {
        throw new Error('transport offline')
      },
    } as unknown as MailManager
    const driver = new MailNotificationDriver({ name: 'mail', mail })
    let caught: unknown
    try {
      await driver.send(alice, new WelcomeEmail(), context)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NotificationDeliveryError)
    expect((caught as Error).message).toContain('send failed')
  })
})
