/**
 * `SessionRepository` — the data-access object for `Session`.
 *
 * Adds session-specific finders on top of the generic Repository<TModel>:
 *   - `findValid(id)`: looks up by id AND checks `expires_at > now()` in one
 *     round-trip. The Guard's `authenticate` path goes through here.
 *   - `deleteExpired(now?)`: bulk cleanup for the eventual `sessions:gc`
 *     console command (lands with `@strav/cli`). Returns the affected
 *     row count.
 *
 * Repository takes an options bag (`{ db, events?, registry?, cipher? }`)
 * so subclasses can't drop a slot — see `docs/code-quality.md` §4.1.
 * App factories bind via `app.singleton(SessionRepository, (c) => new
 * SessionRepository({ db: c.resolve(PostgresDatabase), events: c.resolve(EventBus) }))`.
 */

import { quoteIdent, Repository } from '@strav/database'
import { Session } from './session.ts'
import { sessionSchema } from './session_schema.ts'

export class SessionRepository extends Repository<Session> {
  static override readonly schema = sessionSchema
  static override readonly model = Session

  /** Find a session by id only if it's still valid (expires_at > now()). */
  async findValid(id: string, now: Date = new Date()): Promise<Session | null> {
    return this.query().where('id', id).where('expires_at', '>', now).first()
  }

  /** Bulk delete expired rows. Returns the number of rows removed. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const sql = `DELETE FROM ${quoteIdent(sessionSchema.name)} WHERE ${quoteIdent('expires_at')} <= $1`
    return this.db.execute(sql, [now])
  }

  /**
   * Shallow-merge `partial` into the session's payload and persist. Routes
   * through `this.update()` so the standard auto-`updated_at` bump +
   * lifecycle events (`session.updating` / `session.updated`) still fire.
   *
   * The merge is shallow on purpose — nested-key semantics ("foo.bar.baz =
   * 1") get hairy fast and apps that need them can spread the existing
   * payload themselves. The 90% case is `patchPayload(s, { csrf_token:
   * '…' })` or `patchPayload(s, { 'flash.success': 'Saved' })`.
   */
  async patchPayload(session: Session, partial: Record<string, unknown>): Promise<Session> {
    const next = { ...(session.payload ?? {}), ...partial }
    return this.update(session, { payload: next } as Partial<Session>)
  }

  /**
   * Bulk-delete every session for a user. Used by "log out everywhere"
   * flows and after password changes. Returns the affected row count.
   *
   * Lifecycle events do NOT fire for this bulk operation — it'd be N
   * events for N sessions, with no caller-meaningful payload (the
   * lifecycle event types want a Model, not a count). Apps that need
   * per-session events should iterate explicitly.
   */
  async killAllForUser(userId: string): Promise<number> {
    const sql = `DELETE FROM ${quoteIdent(sessionSchema.name)} WHERE ${quoteIdent('user_id')} = $1`
    return this.db.execute(sql, [userId])
  }
}
