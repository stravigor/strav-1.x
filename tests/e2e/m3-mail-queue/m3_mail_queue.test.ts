/**
 * M3 end-to-end smoke — proves the queue → mail wire end-to-end.
 *
 * Closes the M3 exit-checklist item:
 *   "M3 e2e dispatches a mail job and asserts delivery via the array
 *    transport."
 *
 * The wire under test:
 *
 *   queue.dispatch(WelcomeEmail, { name })   ← user code
 *      → INSERT into strav_jobs                ← DatabaseQueue
 *      → Worker.processOne()
 *        → container.make(WelcomeEmail)       ← @inject() resolves MailManager
 *        → mailable.handle(ctx)               ← Mailable base impl
 *          → mailable.build(payload)          ← user override
 *          → mail.send(message)               ← MailManager
 *            → ArrayTransport.send(message)   ← configured default transport
 *      → DELETE from strav_jobs               ← Worker on success
 *
 * Self-skips when no Postgres is available — matches the integration
 * suites' contract. CI brings up Postgres; local dev does
 * `docker-compose up`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { emitCreateTable, type PostgresDatabase, SchemaRegistry } from '@strav/database'
import { Application } from '@strav/kernel'
import {
  DatabaseQueue,
  failedJobsSchema,
  type JobContext,
  JobRegistry,
  jobSchema,
  Worker,
} from '@strav/queue'
import {
  type ArrayTransport,
  Mailable,
  type MailConfig,
  MailManager,
  type Message,
} from '@strav/signal'
import {
  createTestDatabase,
  isPostgresAvailable,
  resetSchema,
} from '../../support/postgres_test_db.ts'

const PG_AVAILABLE = await isPostgresAvailable()

// ─── Fixture: a Mailable subclass ────────────────────────────────────────────

interface WelcomePayload {
  name: string
}

class WelcomeEmail extends Mailable<WelcomePayload> {
  static override readonly jobName = 'mail.welcome'
  static override readonly maxAttempts = 1

  build(payload: WelcomePayload): Message {
    return {
      to: `${payload.name.toLowerCase()}@example.com`,
      subject: `Welcome, ${payload.name}`,
      text: `Hi ${payload.name} — thanks for signing up.`,
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mailConfig(): MailConfig {
  return {
    default: 'array',
    from: 'noreply@acme.com',
    transports: { array: { driver: 'array' } },
  }
}

describe.skipIf(!PG_AVAILABLE)('M3 e2e: queue → Mailable → ArrayTransport', () => {
  let app: Application
  let db: PostgresDatabase
  let queue: DatabaseQueue
  let worker: Worker
  let mail: MailManager
  let registry: JobRegistry

  beforeAll(async () => {
    // Set up the test schema OUTSIDE the app so the table exists when
    // the worker tries to SELECT FOR UPDATE.
    db = createTestDatabase()
    await resetSchema(db)
    const setupRegistry = new SchemaRegistry().registerAll([jobSchema, failedJobsSchema])
    await db.execute(emitCreateTable(jobSchema, { registry: setupRegistry }).sql)
    await db.execute(emitCreateTable(failedJobsSchema, { registry: setupRegistry }).sql)

    // Boot the Application. We use the kernel/signal providers but wire
    // the queue + database manually (no QueueProvider ships yet — apps
    // do the same in production).
    const { ConfigProvider, LoggerProvider } = await import('@strav/kernel')
    const { DatabaseProvider, PostgresDatabase: PgDb } = await import('@strav/database')
    const { MailProvider } = await import('@strav/signal')

    app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'main',
          level: 'silent',
          channels: { main: { driver: 'stderr' } },
        },
        database: {
          url: `postgres://${process.env.DB_USER}:${encodeURIComponent(
            process.env.DB_PASSWORD as string,
          )}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
        },
        mail: mailConfig(),
      }),
      new LoggerProvider(),
      new DatabaseProvider(),
      new MailProvider(),
    ])
    await app.start({ signalHandlers: false })

    // Wire queue + worker + registry from the booted container.
    const dbInApp = app.resolve(PgDb)
    queue = new DatabaseQueue({ db: dbInApp, container: app })
    registry = new JobRegistry().register(WelcomeEmail)
    worker = new Worker({
      db: dbInApp,
      registry,
      container: app,
      queues: ['default'],
    })
    mail = app.resolve(MailManager)
  })

  afterAll(async () => {
    await app?.shutdown()
    await db?.close({ timeout: 2 })
  })

  test('dispatch + Worker.processOne delivers a Message to ArrayTransport', async () => {
    const jobId = await queue.dispatch(WelcomeEmail, { name: 'Alice' })
    expect(jobId).toMatch(/^[0-9A-Z]{26}$/) // ULID

    const result = await worker.processOne()
    expect(result?.status).toBe('completed')
    expect(result?.jobId).toBe(jobId)

    // Row deleted on success.
    const row = await db.queryOne(`SELECT id FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(row).toBeNull()

    // ArrayTransport recorded the built Message.
    const transport = mail.via() as ArrayTransport
    expect(transport.count).toBe(1)
    const sent = transport.messages[0] as Message
    expect(sent.to).toBe('alice@example.com')
    expect(sent.subject).toBe('Welcome, Alice')
    expect(sent.text).toBe('Hi Alice — thanks for signing up.')
    // default-from substitution flowed through Mailable → MailManager.
    expect(sent.from).toBe('noreply@acme.com')
  })

  test('payload round-trips through JSON without corruption', async () => {
    const transport = mail.via() as ArrayTransport
    transport.clear()

    // A payload with all JSON-friendly shapes: strings, numbers, nesting,
    // unicode. Proves the dispatch → handle hop is lossless.
    class StructuredEmail extends Mailable<{
      name: string
      visits: number
      meta: { plan: string; flags: string[] }
    }> {
      static override readonly jobName = 'mail.structured'
      static override readonly maxAttempts = 1

      build(payload: {
        name: string
        visits: number
        meta: { plan: string; flags: string[] }
      }): Message {
        return {
          to: 'structured@example.com',
          subject: `Hi ${payload.name} (${payload.visits} visits)`,
          text: `plan=${payload.meta.plan} flags=${payload.meta.flags.join(',')}`,
        }
      }
    }
    registry.register(StructuredEmail)

    const jobId = await queue.dispatch(StructuredEmail, {
      name: 'Renée',
      visits: 42,
      meta: { plan: 'pro', flags: ['beta', 'eu'] },
    })
    const result = await worker.processOne()
    expect(result?.status).toBe('completed')
    expect(result?.jobId).toBe(jobId)

    const sent = transport.messages[0] as Message
    expect(sent.subject).toBe('Hi Renée (42 visits)')
    expect(sent.text).toBe('plan=pro flags=beta,eu')
  })

  test('Mailable failure routes through failed_jobs dead-letter', async () => {
    const transport = mail.via() as ArrayTransport
    transport.clear()

    class BrokenEmail extends Mailable<{ name: string }> {
      static override readonly jobName = 'mail.broken'
      static override readonly maxAttempts = 1

      build(_payload: { name: string }): Message {
        throw new Error('build is permanently broken')
      }
    }
    registry.register(BrokenEmail)

    const jobId = await queue.dispatch(BrokenEmail, { name: 'never-receives' })
    const result = await worker.processOne()
    expect(result?.status).toBe('failed')

    // Original row gone.
    const jobRow = await db.queryOne(`SELECT id FROM "strav_jobs" WHERE id = $1`, [jobId])
    expect(jobRow).toBeNull()

    // Failed-jobs row exists with the captured exception.
    const failed = await db.queryOne<{
      job_name: string
      payload: { name: string }
      exception: string
    }>(`SELECT job_name, payload, exception FROM "strav_failed_jobs" WHERE job_name = $1`, [
      'mail.broken',
    ])
    expect(failed?.job_name).toBe('mail.broken')
    expect(failed?.payload).toEqual({ name: 'never-receives' })
    expect(failed?.exception).toContain('build is permanently broken')

    // ArrayTransport never received anything for the broken job.
    expect(transport.count).toBe(0)

    // Clean up the failed_jobs row so re-runs don't accumulate.
    await db.execute(`DELETE FROM "strav_failed_jobs" WHERE job_name = $1`, ['mail.broken'])
  })

  // Reference unused import so verbatimModuleSyntax doesn't trip.
  test('JobContext type is exported (compile-only check)', () => {
    const _ctxShape: keyof JobContext<unknown> = 'jobId'
    expect(_ctxShape).toBe('jobId')
  })
})

describe.skipIf(PG_AVAILABLE)('M3 e2e: queue → Mailable → ArrayTransport (skipped — no DB)', () => {
  test('m3 mail-queue e2e skipped — set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE or run docker-compose', () => {
    expect(true).toBe(true)
  })
})
