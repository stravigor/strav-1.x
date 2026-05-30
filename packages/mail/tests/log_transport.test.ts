import { describe, expect, test } from 'bun:test'
import type { Logger } from '@strav/kernel'
import { LogTransport, type Message } from '../src/index.ts'

interface LogCall {
  level: string
  msg: string
  fields: Record<string, unknown> | undefined
}

function makeRecordingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const record =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      calls.push({ level, msg, fields })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    trace: record('trace'),
    child: () => makeRecordingLogger().logger,
  } as unknown as Logger
  return { logger, calls }
}

describe('LogTransport', () => {
  test('writes one info record per send with safe metadata', async () => {
    const { logger, calls } = makeRecordingLogger()
    const transport = new LogTransport({ logger })
    const m: Message = {
      to: 'alice@example.com',
      from: 'noreply@example.com',
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    }
    await transport.send(m)
    expect(calls.length).toBe(1)
    expect(calls[0]?.level).toBe('info')
    expect(calls[0]?.msg).toBe('mail.sent')
    const mail = calls[0]?.fields?.mail as Record<string, unknown>
    expect(mail.to).toBe('alice@example.com')
    expect(mail.from).toBe('noreply@example.com')
    expect(mail.subject).toBe('hi')
    expect(mail.hasHtml).toBe(true)
    expect(mail.hasText).toBe(true)
    // Bodies excluded by default.
    expect(mail.html).toBeUndefined()
    expect(mail.text).toBeUndefined()
  })

  test('honors the configured level', async () => {
    const { logger, calls } = makeRecordingLogger()
    const transport = new LogTransport({ logger, level: 'debug' })
    await transport.send({ to: 'a@x', subject: 's', text: 't' })
    expect(calls[0]?.level).toBe('debug')
  })

  test('includeBody opts bodies into the record', async () => {
    const { logger, calls } = makeRecordingLogger()
    const transport = new LogTransport({ logger, includeBody: true })
    await transport.send({
      to: 'a@x',
      subject: 's',
      html: '<p>body</p>',
      text: 'body',
    })
    const mail = calls[0]?.fields?.mail as Record<string, unknown>
    expect(mail.html).toBe('<p>body</p>')
    expect(mail.text).toBe('body')
  })

  test('attachments record filename + contentType only, never bytes', async () => {
    const { logger, calls } = makeRecordingLogger()
    const transport = new LogTransport({ logger })
    await transport.send({
      to: 'a@x',
      subject: 's',
      text: 't',
      attachments: [{ filename: 'a.pdf', content: 'binary-bytes', contentType: 'application/pdf' }],
    })
    const mail = calls[0]?.fields?.mail as Record<string, unknown>
    const attachments = mail.attachments as Array<Record<string, unknown>>
    expect(attachments).toEqual([{ filename: 'a.pdf', contentType: 'application/pdf' }])
  })
})
