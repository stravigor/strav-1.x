/**
 * `bun strav migrate:generate -m "msg"` — diff schemas vs DB, write a
 * `Migration` file.
 *
 * Steps:
 *   1. Resolve `SchemaRegistry` + `Database` from the container.
 *   2. Call `generateMigration({ registry, db, name })` — same code path
 *      the existing diff engine uses.
 *   3. Emit a `database/migrations/<timestamp>_<slug>.ts` file that
 *      embeds each op's `sql` string into `up()` and the reverse SQL
 *      into `down()`.
 *
 * `-m` / `--message` is required so the filename slug is meaningful.
 * `--allow-drop` and `--allow-alter` pass through to the diff engine
 * (off by default; matches `generateMigration`'s opt-in defaults).
 * `--dry-run` prints the file content to stdout instead of writing.
 *
 * Limitations:
 *   - Rename ops aren't auto-detected from a diff; the command does NOT
 *     expose `--renames`. Apps that need renames hand-write the migration.
 *   - `down()` for `drop-table` / `drop-column` is a no-op (the diff
 *     discarded the original schema). Apps recreate dropped entities
 *     by hand if they need to undo.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Command, type ExecuteArgs, ExitCode, UsageError } from '@strav/cli'
import { ConfigError } from '@strav/kernel'
import { PostgresDatabase } from '../database.ts'
import {
  type DiffOperation,
  type DiffResult,
  emitAlterColumnSql,
  generateMigration,
} from '../diff/index.ts'
import { SchemaRegistry } from '../schema_registry.ts'

export class MigrateGenerate extends Command {
  static signature =
    'migrate:generate {--message=} {--allow-drop} {--allow-alter} {--dry-run} {--out=database/migrations}'
  static description = 'Diff registered schemas vs the live DB and emit a migration file.'
  static providers = ['config', 'logger', 'database']

  override async execute({ flags }: ExecuteArgs): Promise<number> {
    const message = (flags.message as string | '').trim()
    if (!message) {
      throw new UsageError('flag --message (or -m) is required — describe what the migration does')
    }
    const slug = slugify(message)
    if (!slug) {
      throw new UsageError(`--message "${message}" produced an empty slug — use letters / digits`)
    }

    if (!this.app.has(SchemaRegistry)) {
      throw new ConfigError(
        'migrate:generate: SchemaRegistry is not bound. Register it in your provider via ' +
          '`app.singleton(SchemaRegistry, () => new SchemaRegistry().registerAll([...]))` — ' +
          'see docs/database/guides/schemas.md.',
      )
    }

    const registry = this.app.resolve(SchemaRegistry)
    const db = this.app.resolve(PostgresDatabase)
    const now = new Date()
    const name = `${timestamp(now)}_${slug}`

    const generated = await generateMigration({
      registry,
      db,
      name,
      allowDrop: flags['allow-drop'] === true,
      allowAlter: flags['allow-alter'] === true,
      now,
    })

    if (!generated) {
      this.info('No diff — the database matches every registered schema.')
      return ExitCode.Success
    }

    const fileContent = renderMigrationFile(name, generated.diff)
    const outDir = flags.out as string
    const filePath = join(outDir, `${name}.ts`)

    if (flags['dry-run'] === true) {
      this.line(`# --- ${filePath} ---`)
      this.line(fileContent)
      return ExitCode.Success
    }

    await mkdir(outDir, { recursive: true })
    await writeFile(filePath, fileContent, 'utf8')
    this.success(`Wrote ${filePath}`)
    this.line(`  ${generated.diff.operations.length} op(s):`)
    for (const op of generated.diff.operations) {
      this.line(`    • ${op.kind} ${describeOp(op)}`)
    }
    if (generated.diff.unknownTables.length > 0) {
      this.warn(
        `Unknown tables not in registry: ${generated.diff.unknownTables.join(', ')} (use --allow-drop to drop them).`,
      )
    }
    return ExitCode.Success
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** YYYYMMDDHHMMSS in UTC — matches `defaultMigrationName` in generate.ts. */
function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('')
}

/** Lowercase, alphanumerics + underscores. Drops everything else. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Render the .ts file content for the generated migration. */
function renderMigrationFile(name: string, diff: DiffResult): string {
  const upStatements = diff.operations.map((op) => sqlExecuteCall(op.sql))
  const downStatements = diff.operations
    .slice()
    .reverse()
    .map((op) => downSqlForOp(op))
    .filter((s): s is string => s !== null)
    .map(sqlExecuteCall)

  const body = [
    "import type { Migration } from '@strav/database'",
    '',
    `export const migration: Migration = {`,
    `  name: '${name}',`,
    `  async up(db) {`,
    upStatements.length > 0 ? upStatements.map((s) => `    ${s}`).join('\n') : '    // no-op',
    `  },`,
    `  async down(db) {`,
    downStatements.length > 0
      ? downStatements.map((s) => `    ${s}`).join('\n')
      : '    // no-op — drops have no clean inverse',
    `  },`,
    `}`,
    '',
  ]
  return body.join('\n')
}

/** Wrap a SQL string in an `await db.execute(...)` line. Template-literal-safe. */
function sqlExecuteCall(sql: string): string {
  // Use a template literal so multi-statement SQL (alter-column) prints with
  // real newlines instead of \\n escapes.
  return `await db.execute(\`${sql.replace(/`/g, '\\`')}\`)`
}

/** Compute the reverse SQL for one op, or null when no clean inverse exists. */
function downSqlForOp(op: DiffOperation): string | null {
  switch (op.kind) {
    case 'add-column':
      return `ALTER TABLE "${op.schemaName}" DROP COLUMN IF EXISTS "${op.columnName}"`
    case 'create-table':
      return `DROP TABLE IF EXISTS "${op.schemaName}"`
    case 'rename-table':
      return `ALTER TABLE "${op.to}" RENAME TO "${op.from}"`
    case 'rename-column':
      return `ALTER TABLE "${op.tableName}" RENAME COLUMN "${op.to}" TO "${op.from}"`
    case 'alter-column':
      return emitAlterColumnSql(op.tableName, op.columnName, op.to, op.from)
    case 'drop-table':
    case 'drop-column':
      // No clean inverse — see file-level doc comment.
      return null
  }
}

/** One-line description of an op for the success summary. */
function describeOp(op: DiffOperation): string {
  switch (op.kind) {
    case 'create-table':
      return op.schemaName
    case 'add-column':
      return `${op.schemaName}.${op.columnName}`
    case 'drop-table':
      return op.tableName
    case 'drop-column':
      return `${op.tableName}.${op.columnName}`
    case 'rename-table':
      return `${op.from} → ${op.to}`
    case 'rename-column':
      return `${op.tableName}.${op.from} → ${op.to}`
    case 'alter-column':
      return `${op.tableName}.${op.columnName} (${op.from.type} → ${op.to.type})`
  }
}
