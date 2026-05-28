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
 * `@inject()` makes the container resolve `PostgresDatabase` via the
 * Repository base constructor.
 */

// biome-ignore lint/style/useImportType: PostgresDatabase needs to be a value import — the @inject() decorator below resolves the constructor param via reflect-metadata, which requires the runtime class reference. `import type` erases it; the container then resolves the param to `Object` and the wiring silently breaks.
import { PostgresDatabase, quoteIdent, Repository } from '@strav/database'
// biome-ignore lint/style/useImportType: EventBus has the same constraint as PostgresDatabase — reflect-metadata needs the runtime class for @inject() param resolution.
import { EventBus, inject } from '@strav/kernel'
import { Session } from './session.ts'
import { sessionSchema } from './session_schema.ts'

@inject()
export class SessionRepository extends Repository<Session> {
  static override readonly schema = sessionSchema
  static override readonly model = Session

  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor forces TypeScript to emit `design:paramtypes` metadata on the subclass for the @inject() decorator above — without it the container resolves the inherited constructor to no params and the repo never gets its dependencies.
  constructor(db: PostgresDatabase, events: EventBus) {
    super(db, events)
  }

  /** Find a session by id only if it's still valid (expires_at > now()). */
  async findValid(id: string, now: Date = new Date()): Promise<Session | null> {
    return this.query().where('id', id).where('expires_at', '>', now).first()
  }

  /** Bulk delete expired rows. Returns the number of rows removed. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const sql = `DELETE FROM ${quoteIdent(sessionSchema.name)} WHERE ${quoteIdent('expires_at')} <= $1`
    return this.db.execute(sql, [now])
  }
}
