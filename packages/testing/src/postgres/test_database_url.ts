/**
 * Reads the standard env-var contract (`DB_HOST` / `DB_PORT` / `DB_USER` /
 * `DB_PASSWORD` / `DB_DATABASE`) shared with CI and `.env.test` and
 * assembles a Postgres URL. Returns `null` when any required variable
 * is missing — callers self-skip rather than throw, so `bun test` is a
 * no-op for integration tests in environments without local Postgres.
 */

interface PgEnv {
  host: string
  port: string
  user: string
  password: string
  database: string
}

function readPgEnv(): PgEnv | null {
  const host = process.env.DB_HOST
  const port = process.env.DB_PORT
  const user = process.env.DB_USER
  const password = process.env.DB_PASSWORD
  const database = process.env.DB_DATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export function testDatabaseUrl(): string | null {
  const env = readPgEnv()
  if (env === null) return null
  // `encodeURIComponent` so a password containing `@` or `:` doesn't
  // corrupt the URL.
  return `postgres://${env.user}:${encodeURIComponent(env.password)}@${env.host}:${env.port}/${env.database}`
}
