import { describe, expect, test } from 'bun:test'
import {
  Archetype,
  columnDefinition,
  defaultSql,
  defineSchema,
  emitAddColumn,
  emitCreateIndex,
  emitCreateTable,
  emitDropColumn,
  emitDropIndex,
  emitDropTable,
  emitRenameColumn,
  emitRenameTable,
  findPrimaryKey,
  isPrimaryKeyKind,
  type SchemaField,
  SchemaRegistry,
  sqlTypeFor,
} from '../src/index.ts'

// ─── sqlTypeFor (kind → Postgres type) ────────────────────────────────────────

describe('sqlTypeFor', () => {
  test('id → char(26)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.id())
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('char(26)')
  })

  test('uuid → uuid', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.uuid())
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('uuid')
  })

  test('bigSerial → bigserial', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.bigSerial())
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('bigserial')
  })

  test('tenantedSerial → bigint (per-tenant sequencing deferred)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.tenantedSerial())
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('bigint')
  })

  test('string → varchar(max)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.string('a')
      t.string('b').max(320)
    })
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('varchar(255)')
    expect(sqlTypeFor(s.fields[1] as SchemaField)).toBe('varchar(320)')
  })

  test('text → text', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.text('bio'))
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('text')
  })

  test('integer / boolean primitives', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.integer('n')
      t.boolean('b')
    })
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('integer')
    expect(sqlTypeFor(s.fields[1] as SchemaField)).toBe('boolean')
  })

  test('decimal(p, s) → numeric(p, s)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.decimal('amount', 12, 4))
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('numeric(12, 4)')
  })

  test('json → jsonb (not json — modern Postgres default)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.json('payload'))
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('jsonb')
  })

  test('timestamp → timestamptz by default, timestamp when withTimezone:false', () => {
    const a = defineSchema('a', Archetype.Entity, (t) => t.timestamp('at'))
    const b = defineSchema('b', Archetype.Entity, (t) => t.timestamp('at', { withTimezone: false }))
    expect(sqlTypeFor(a.fields[0] as SchemaField)).toBe('timestamptz')
    expect(sqlTypeFor(b.fields[0] as SchemaField)).toBe('timestamp')
  })

  test('enum → text (CHECK is added by columnDefinition, not the type)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.enum('status', ['active', 'banned']))
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('text')
  })

  test('encrypted → bytea', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.encrypted('secret'))
    expect(sqlTypeFor(s.fields[0] as SchemaField)).toBe('bytea')
  })

  test('reference adopts the target PK type via the registry', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('user_id').to(user)
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    const userIdField = post.fields[1] as SchemaField
    expect(sqlTypeFor(userIdField, registry)).toBe('char(26)')
  })

  test('reference resolves through a uuid PK', () => {
    const tenant = defineSchema('tenant', Archetype.Entity, (t) => t.uuid())
    const member = defineSchema('member', Archetype.Entity, (t) => {
      t.id()
      t.reference('tenant_id').to(tenant)
    })
    const registry = new SchemaRegistry().registerAll([tenant, member])
    expect(sqlTypeFor(member.fields[1] as SchemaField, registry)).toBe('uuid')
  })

  test('reference throws when target schema is missing from registry', () => {
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('user_id').to('user')
    })
    const empty = new SchemaRegistry()
    expect(() => sqlTypeFor(post.fields[1] as SchemaField, empty)).toThrow(/not registered/)
  })

  test('reference throws when no registry is passed', () => {
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('user_id').to('user')
    })
    expect(() => sqlTypeFor(post.fields[1] as SchemaField)).toThrow(/not registered/)
  })
})

// ─── findPrimaryKey + isPrimaryKeyKind ────────────────────────────────────────

describe('findPrimaryKey', () => {
  test('returns the id field for the canonical case', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.string('email')
    })
    expect(findPrimaryKey(s).name).toBe('id')
    expect(findPrimaryKey(s).kind).toBe('id')
  })

  test('returns the renamed identity field', () => {
    const s = defineSchema('country', Archetype.Reference, (t) => {
      t.id('code')
      t.string('name')
    })
    expect(findPrimaryKey(s).name).toBe('code')
  })

  test('finds uuid / bigSerial / tenantedSerial too', () => {
    const a = defineSchema('a', Archetype.Entity, (t) => t.uuid())
    const b = defineSchema('b', Archetype.Entity, (t) => t.bigSerial())
    const c = defineSchema('c', Archetype.Entity, (t) => t.tenantedSerial())
    expect(findPrimaryKey(a).kind).toBe('uuid')
    expect(findPrimaryKey(b).kind).toBe('bigSerial')
    expect(findPrimaryKey(c).kind).toBe('tenantedSerial')
  })

  test('throws when no identity field is present', () => {
    const s = defineSchema('orphan', Archetype.Entity, (t) => t.string('foo'))
    expect(() => findPrimaryKey(s)).toThrow(/no identity field/)
  })
})

describe('isPrimaryKeyKind', () => {
  test('true for id/uuid/bigSerial/tenantedSerial', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.uuid('alt_id')
      t.bigSerial('big')
      t.tenantedSerial('tenanted')
    })
    expect(s.fields.every(isPrimaryKeyKind)).toBe(true)
  })

  test('false for scalars + reference', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.string('a')
      t.text('b')
      t.integer('c')
      t.boolean('d')
      t.json('e')
      t.timestamp('f')
      t.enum('g', ['x'])
      t.encrypted('h')
      t.reference('i').to('other')
    })
    expect(s.fields.some(isPrimaryKeyKind)).toBe(false)
  })
})

// ─── columnDefinition (per-field DDL) ─────────────────────────────────────────

describe('columnDefinition', () => {
  test('id field gets PRIMARY KEY and skips redundant NOT NULL / UNIQUE', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.id())
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe('"id" char(26) PRIMARY KEY')
  })

  test('bigSerial field gets PRIMARY KEY', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.bigSerial())
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe('"id" bigserial PRIMARY KEY')
  })

  test('scalar field defaults to NOT NULL', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.string('email'))
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe('"email" varchar(255) NOT NULL')
  })

  test('nullable() drops NOT NULL', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.string('nickname').nullable())
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe('"nickname" varchar(255)')
  })

  test('unique() adds UNIQUE on a non-PK column', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.string('email').unique())
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe(
      '"email" varchar(255) NOT NULL UNIQUE',
    )
  })

  test('default(literal) escapes strings + inlines booleans/numbers', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.string('status').default("o'reilly")
      t.boolean('is_active').default(true)
      t.integer('count').default(42)
    })
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe(
      `"status" varchar(255) NOT NULL DEFAULT 'o''reilly'`,
    )
    expect(columnDefinition(s.fields[1] as SchemaField)).toBe(
      '"is_active" boolean NOT NULL DEFAULT true',
    )
    expect(columnDefinition(s.fields[2] as SchemaField)).toBe('"count" integer NOT NULL DEFAULT 42')
  })

  test('default({ sql: "..." }) emits raw SQL (the timestamps() marker)', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.timestamps())
    const createdAt = s.fields.find((f) => f.name === 'created_at') as SchemaField
    expect(columnDefinition(createdAt)).toBe('"created_at" timestamptz NOT NULL DEFAULT now()')
  })

  test('enum field appends a CHECK constraint', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.enum('status', ['active', 'banned']))
    expect(columnDefinition(s.fields[0] as SchemaField)).toBe(
      `"status" text NOT NULL CHECK ("status" IN ('active', 'banned'))`,
    )
  })

  test('reference field emits REFERENCES with ON DELETE', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('user_id').to(user).onDelete('cascade')
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    expect(columnDefinition(post.fields[1] as SchemaField, registry)).toBe(
      '"user_id" char(26) NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE',
    )
  })

  test('reference honors target PK column name (renamed identity)', () => {
    const country = defineSchema('country', Archetype.Reference, (t) => {
      t.id('code')
    })
    const user = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.reference('country_code').to(country)
    })
    const registry = new SchemaRegistry().registerAll([country, user])
    expect(columnDefinition(user.fields[1] as SchemaField, registry)).toBe(
      '"country_code" char(26) NOT NULL REFERENCES "country" ("code") ON DELETE RESTRICT',
    )
  })

  test('nullable reference + onDelete set null', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('editor_id').to(user).nullable().onDelete('set null')
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    expect(columnDefinition(post.fields[1] as SchemaField, registry)).toBe(
      '"editor_id" char(26) REFERENCES "user" ("id") ON DELETE SET NULL',
    )
  })
})

// ─── defaultSql ───────────────────────────────────────────────────────────────

describe('defaultSql', () => {
  test('null → NULL', () => {
    expect(defaultSql(null)).toBe('NULL')
  })
  test('string escapes single-quotes', () => {
    expect(defaultSql("it's fine")).toBe(`'it''s fine'`)
  })
  test('numbers + bigint + boolean → inline', () => {
    expect(defaultSql(7)).toBe('7')
    expect(defaultSql(1n)).toBe('1')
    expect(defaultSql(true)).toBe('true')
    expect(defaultSql(false)).toBe('false')
  })
  test('json object/array → jsonb cast', () => {
    expect(defaultSql({ a: 1 })).toBe(`'{"a":1}'::jsonb`)
    expect(defaultSql([])).toBe(`'[]'::jsonb`)
  })
  test('{ sql: ... } marker emits raw SQL', () => {
    expect(defaultSql({ sql: 'now()' })).toBe('now()')
    expect(defaultSql({ sql: 'gen_random_uuid()' })).toBe('gen_random_uuid()')
  })
})

// ─── emitCreateTable ──────────────────────────────────────────────────────────

describe('emitCreateTable', () => {
  test('minimal table — just an id', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.id())
    expect(emitCreateTable(s).sql).toBe(`CREATE TABLE "x" (\n  "id" char(26) PRIMARY KEY\n)`)
  })

  test('full canonical user-like schema with timestamps()', () => {
    const s = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('email').max(320).unique()
      t.string('password_hash').max(512)
      t.boolean('is_active').default(true)
      t.timestamps()
    })
    const { sql } = emitCreateTable(s)
    expect(sql).toBe(
      [
        `CREATE TABLE "user" (`,
        `  "id" char(26) PRIMARY KEY,`,
        `  "email" varchar(320) NOT NULL UNIQUE,`,
        `  "password_hash" varchar(512) NOT NULL,`,
        `  "is_active" boolean NOT NULL DEFAULT true,`,
        `  "created_at" timestamptz NOT NULL DEFAULT now(),`,
        `  "updated_at" timestamptz NOT NULL DEFAULT now()`,
        `)`,
      ].join('\n'),
    )
  })

  test('softDeletes() emits a nullable deleted_at', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.softDeletes()
    })
    const { sql } = emitCreateTable(s)
    expect(sql).toContain('"deleted_at" timestamptz')
    expect(sql).not.toMatch(/"deleted_at" timestamptz NOT NULL/)
  })

  test('enum column emits CHECK inline', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => {
      t.id()
      t.enum('role', ['admin', 'member'])
    })
    expect(emitCreateTable(s).sql).toContain(
      `"role" text NOT NULL CHECK ("role" IN ('admin', 'member'))`,
    )
  })

  test('reference column emits REFERENCES inline', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('author_id').to(user)
      t.timestamps()
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    const { sql } = emitCreateTable(post, { registry })
    expect(sql).toContain(
      '"author_id" char(26) NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT',
    )
  })

  test('IF NOT EXISTS variant', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.id())
    expect(emitCreateTable(s, { ifExists: true }).sql).toContain('CREATE TABLE IF NOT EXISTS "x"')
  })
})

// ─── emitDropTable / emitAddColumn / emitDropColumn ───────────────────────────

describe('emitDropTable', () => {
  test('basic drop', () => {
    expect(emitDropTable('user').sql).toBe('DROP TABLE "user"')
  })
  test('IF EXISTS variant', () => {
    expect(emitDropTable('user', { ifExists: true }).sql).toBe('DROP TABLE IF EXISTS "user"')
  })
})

describe('emitAddColumn', () => {
  test('reuses columnDefinition — same shape as CREATE TABLE', () => {
    const s = defineSchema('user', Archetype.Entity, (t) => {
      t.id()
      t.string('handle').max(64).nullable()
    })
    expect(emitAddColumn(s, 'handle').sql).toBe(
      'ALTER TABLE "user" ADD COLUMN "handle" varchar(64)',
    )
  })

  test('threads the registry for references', () => {
    const user = defineSchema('user', Archetype.Entity, (t) => t.id())
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.reference('author_id').to(user)
    })
    const registry = new SchemaRegistry().registerAll([user, post])
    expect(emitAddColumn(post, 'author_id', { registry }).sql).toBe(
      'ALTER TABLE "post" ADD COLUMN "author_id" char(26) NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT',
    )
  })

  test('throws on unknown field name', () => {
    const s = defineSchema('x', Archetype.Entity, (t) => t.id())
    expect(() => emitAddColumn(s, 'nope')).toThrow(/no such field/)
  })
})

describe('emitDropColumn', () => {
  test('basic drop column', () => {
    expect(emitDropColumn('user', 'old_col').sql).toBe('ALTER TABLE "user" DROP COLUMN "old_col"')
  })
  test('IF EXISTS variant', () => {
    expect(emitDropColumn('user', 'old_col', { ifExists: true }).sql).toBe(
      'ALTER TABLE "user" DROP COLUMN IF EXISTS "old_col"',
    )
  })
})

// ─── Rename emitters ─────────────────────────────────────────────────────────

describe('emitRenameTable', () => {
  test('emits ALTER TABLE … RENAME TO …', () => {
    expect(emitRenameTable('users', 'account').sql).toBe('ALTER TABLE "users" RENAME TO "account"')
  })
})

describe('emitRenameColumn', () => {
  test('emits ALTER TABLE … RENAME COLUMN … TO …', () => {
    expect(emitRenameColumn('user', 'email_address', 'email').sql).toBe(
      'ALTER TABLE "user" RENAME COLUMN "email_address" TO "email"',
    )
  })
})

// ─── Index emitters ──────────────────────────────────────────────────────────

describe('emitCreateIndex', () => {
  test('single column with default name', () => {
    expect(emitCreateIndex('user', ['email']).sql).toBe(
      'CREATE INDEX "user_email_idx" ON "user" ("email")',
    )
  })

  test('multi-column compound index, default name', () => {
    expect(emitCreateIndex('user', ['tenant_id', 'email']).sql).toBe(
      'CREATE INDEX "user_tenant_id_email_idx" ON "user" ("tenant_id", "email")',
    )
  })

  test('explicit name', () => {
    expect(emitCreateIndex('user', ['email'], { name: 'idx_user_email_lowered' }).sql).toBe(
      'CREATE INDEX "idx_user_email_lowered" ON "user" ("email")',
    )
  })

  test('UNIQUE variant', () => {
    expect(emitCreateIndex('user', ['email'], { unique: true }).sql).toBe(
      'CREATE UNIQUE INDEX "user_email_idx" ON "user" ("email")',
    )
  })

  test('partial unique index — soft-delete pattern', () => {
    expect(
      emitCreateIndex('user', ['email'], {
        unique: true,
        where: '"deleted_at" IS NULL',
      }).sql,
    ).toBe('CREATE UNIQUE INDEX "user_email_idx" ON "user" ("email") WHERE "deleted_at" IS NULL')
  })

  test('USING gin clause', () => {
    expect(emitCreateIndex('user', ['payload'], { using: 'gin' }).sql).toBe(
      'CREATE INDEX "user_payload_idx" ON "user" USING gin ("payload")',
    )
  })

  test('IF NOT EXISTS', () => {
    expect(emitCreateIndex('user', ['email'], { ifExists: true }).sql).toBe(
      'CREATE INDEX IF NOT EXISTS "user_email_idx" ON "user" ("email")',
    )
  })

  test('throws on empty column list', () => {
    expect(() => emitCreateIndex('user', [])).toThrow(/at least one column/)
  })
})

describe('emitDropIndex', () => {
  test('basic drop', () => {
    expect(emitDropIndex('user_email_idx').sql).toBe('DROP INDEX "user_email_idx"')
  })
  test('IF EXISTS variant', () => {
    expect(emitDropIndex('user_email_idx', { ifExists: true }).sql).toBe(
      'DROP INDEX IF EXISTS "user_email_idx"',
    )
  })
})
