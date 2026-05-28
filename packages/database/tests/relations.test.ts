import { describe, expect, test } from 'bun:test'
import type { Database, DatabaseExecutor } from '../src/database.ts'
import {
  Archetype,
  defineSchema,
  Model,
  type ModelClass,
  type PaginatedResult,
  type PostgresDatabase,
  QueryBuilder,
  Repository,
  SchemaRegistry,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + fakes
// ─────────────────────────────────────────────────────────────────────────────

function nonNull<T>(v: T | null | undefined, msg = 'expected non-null'): T {
  if (v === null || v === undefined) throw new Error(msg)
  return v
}

const userSchema = defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.string('email').unique()
  t.timestamps()
  t.hasMany('post', { foreignKey: 'user_id', as: 'posts' })
})

const postSchema = defineSchema('post', Archetype.Entity, (t) => {
  t.id()
  t.string('title')
  t.reference('user_id').to(userSchema)
  t.timestamps()
  t.belongsTo(userSchema, { foreignKey: 'user_id', as: 'author' })
})

class User extends Model {
  static override readonly schema = userSchema
  id!: string
  email!: string
  created_at!: Date
  updated_at!: Date
  posts?: Array<Record<string, unknown>>
}

class Post extends Model {
  static override readonly schema = postSchema
  id!: string
  title!: string
  user_id!: string
  created_at!: Date
  updated_at!: Date
  author?: Record<string, unknown> | null
}

class UserRepository extends Repository<User> {
  static override readonly schema = userSchema
  static override readonly model: ModelClass = User as unknown as ModelClass
}

class PostRepository extends Repository<Post> {
  static override readonly schema = postSchema
  static override readonly model: ModelClass = Post as unknown as ModelClass
}

/** Spy DB — records each SQL string + params for assertions; scripts rows by table. */
class SpyDb implements Database {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = []
  /** Rows keyed by table name — returned by query() when the SELECT targets that table. */
  rowsByTable = new Map<string, Record<string, unknown>[]>()

  setRows(table: string, rows: Record<string, unknown>[]): void {
    this.rowsByTable.set(table, rows)
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params })
    const table = extractTable(sql)
    return (this.rowsByTable.get(table ?? '') ?? []) as T[]
  }
  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    this.queries.push({ sql, params })
    if (/COUNT\(\*\)/i.test(sql)) {
      const table = extractTable(sql)
      const rows = this.rowsByTable.get(table ?? '') ?? []
      return { count: rows.length } as T
    }
    const table = extractTable(sql)
    const rows = this.rowsByTable.get(table ?? '') ?? []
    return (rows[0] as T) ?? null
  }
  async execute(): Promise<number> {
    return 0
  }
  async transaction<T>(fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return fn(this as unknown as DatabaseExecutor)
  }
  async close() {}
  raw(): never {
    throw new Error('SpyDb.raw not implemented')
  }
}

function extractTable(sql: string): string | null {
  const match = /FROM "([^"]+)"/i.exec(sql)
  return match?.[1] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema: relations declarations
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema — relation declarations', () => {
  test('t.hasMany stores the relation with the right shape', () => {
    expect(userSchema.relations).toHaveLength(1)
    expect(userSchema.relations[0]).toEqual({
      kind: 'hasMany',
      name: 'posts',
      target: 'post',
      foreignKey: 'user_id',
    })
  })

  test('t.belongsTo stores the relation with the right shape', () => {
    expect(postSchema.relations).toHaveLength(1)
    expect(postSchema.relations[0]).toEqual({
      kind: 'belongsTo',
      name: 'author',
      target: 'user',
      foreignKey: 'user_id',
    })
  })

  test('schemas with no relations get an empty list', () => {
    const bare = defineSchema('bare', Archetype.Entity, (t) => t.id())
    expect(bare.relations).toEqual([])
  })

  test('hasMany without `as` defaults the name to the target', () => {
    const a = defineSchema('a', Archetype.Entity, (t) => {
      t.id()
      t.hasMany('b', { foreignKey: 'a_id' })
    })
    expect(nonNull(a.relations[0]).name).toBe('b')
  })

  test('belongsTo accepts a Schema, a name-bearing object, or a string for target', () => {
    const post = defineSchema('post', Archetype.Entity, (t) => {
      t.id()
      t.belongsTo(userSchema, { foreignKey: 'user_id' })
      t.belongsTo({ name: 'category' }, { foreignKey: 'category_id' })
      t.belongsTo('tag', { foreignKey: 'tag_id' })
    })
    expect(post.relations.map((r) => r.target)).toEqual(['user', 'category', 'tag'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// QueryBuilder.with — eager loading
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder.with — hasMany', () => {
  test('runs one batched SELECT WHERE fk IN (parentIds), attaches as array', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
      { id: 'u2', email: 'b@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    db.setRows('post', [
      { id: 'p1', title: 'Post1', user_id: 'u1', created_at: new Date(), updated_at: new Date() },
      { id: 'p2', title: 'Post2', user_id: 'u1', created_at: new Date(), updated_at: new Date() },
      { id: 'p3', title: 'Post3', user_id: 'u2', created_at: new Date(), updated_at: new Date() },
    ])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new UserRepository(db as unknown as PostgresDatabase, undefined, registry)
    const users = await repo.query().with('posts').get()
    expect(users).toHaveLength(2)
    expect(users[0]?.posts).toHaveLength(2)
    expect(users[1]?.posts).toHaveLength(1)
    const postQuery = nonNull(db.queries.find((q) => /FROM "post"/i.test(q.sql)))
    expect(postQuery.sql).toContain('"user_id" IN ($1, $2)')
    expect(postQuery.params).toEqual(['u1', 'u2'])
  })

  test('attaches an empty array when there are no children for a parent', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u-only', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    db.setRows('post', [])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new UserRepository(db as unknown as PostgresDatabase, undefined, registry)
    const users = await repo.query().with('posts').get()
    expect(users[0]?.posts).toEqual([])
  })

  test('skips the child SELECT when there are zero parents', async () => {
    const db = new SpyDb()
    db.setRows('user', [])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new UserRepository(db as unknown as PostgresDatabase, undefined, registry)
    const users = await repo.query().with('posts').get()
    expect(users).toEqual([])
    expect(db.queries.filter((q) => /FROM "post"/i.test(q.sql))).toEqual([])
  })

  test('first() also eager-loads on the single returned row', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    db.setRows('post', [
      { id: 'p1', title: 'P', user_id: 'u1', created_at: new Date(), updated_at: new Date() },
    ])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new UserRepository(db as unknown as PostgresDatabase, undefined, registry)
    const user = await repo.query().with('posts').first()
    expect(user?.posts).toHaveLength(1)
  })
})

describe('QueryBuilder.with — belongsTo', () => {
  test('runs one batched SELECT WHERE id IN (foreignKeys), attaches as single', async () => {
    const db = new SpyDb()
    db.setRows('post', [
      { id: 'p1', title: 'P1', user_id: 'u1', created_at: new Date(), updated_at: new Date() },
      { id: 'p2', title: 'P2', user_id: 'u2', created_at: new Date(), updated_at: new Date() },
      { id: 'p3', title: 'P3', user_id: 'u1', created_at: new Date(), updated_at: new Date() },
    ])
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
      { id: 'u2', email: 'b@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new PostRepository(db as unknown as PostgresDatabase, undefined, registry)
    const posts = await repo.query().with('author').get()
    expect(posts).toHaveLength(3)
    expect((posts[0]?.author as Record<string, unknown>).id).toBe('u1')
    expect((posts[1]?.author as Record<string, unknown>).id).toBe('u2')
    expect((posts[2]?.author as Record<string, unknown>).id).toBe('u1')
    const authorQuery = nonNull(db.queries.find((q) => /FROM "user"/i.test(q.sql)))
    // Dedup: only 2 placeholders even though 3 posts reference users.
    expect(authorQuery.sql).toContain('"id" IN ($1, $2)')
    expect(authorQuery.params).toEqual(['u1', 'u2'])
  })

  test('attaches null when the foreign-key value is null', async () => {
    const db = new SpyDb()
    db.setRows('post', [
      { id: 'p1', title: 'P1', user_id: null, created_at: new Date(), updated_at: new Date() },
    ])
    db.setRows('user', [])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new PostRepository(db as unknown as PostgresDatabase, undefined, registry)
    const posts = await repo.query().with('author').get()
    expect(posts[0]?.author).toBeNull()
  })
})

describe('QueryBuilder.with — error cases', () => {
  test('throws when no SchemaRegistry was wired', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    const repo = new UserRepository(db as unknown as PostgresDatabase) // no registry
    await expect(repo.query().with('posts').get()).rejects.toThrow(/requires a SchemaRegistry/)
  })

  test('throws on an unknown relation name', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new UserRepository(db as unknown as PostgresDatabase, undefined, registry)
    await expect(repo.query().with('bogus').get()).rejects.toThrow(/no relation named "bogus"/)
  })

  test('chains multiple .with calls — clone preserves the request list', () => {
    const qb = new QueryBuilder<User>(userSchema, {} as DatabaseExecutor, undefined)
    const a = qb.with('posts')
    const b = a.with('drafts') // hypothetical second relation
    // Mutating one shouldn't leak to the other; this assertion is indirect via
    // toSql shape only — the actual eager-load happens in get(). Confirm
    // immutability by checking they're different instances.
    expect(a).not.toBe(b)
    expect(qb).not.toBe(a)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// QueryBuilder.paginate — offset pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryBuilder.paginate', () => {
  test('returns the right { data, total, page, perPage, totalPages } shape', async () => {
    const db = new SpyDb()
    db.setRows(
      'user',
      Array.from({ length: 5 }, (_, i) => ({
        id: `u${i + 1}`,
        email: `u${i + 1}@b.com`,
        created_at: new Date(),
        updated_at: new Date(),
      })),
    )
    const repo = new UserRepository(db as unknown as PostgresDatabase)
    const page1 = await repo.query().paginate({ page: 1, perPage: 2 })
    expect(page1.total).toBe(5)
    expect(page1.page).toBe(1)
    expect(page1.perPage).toBe(2)
    expect(page1.totalPages).toBe(3)
    expect(page1.data).toHaveLength(5) // SpyDb returns all rows regardless of LIMIT
    const select = nonNull(
      db.queries.find((q) => /SELECT .* FROM "user"/i.test(q.sql) && q.sql.includes('LIMIT')),
    )
    expect(select.sql).toContain('LIMIT 2')
    expect(select.sql).toContain('OFFSET 0')
  })

  test('OFFSET is calculated as (page - 1) * perPage', async () => {
    const db = new SpyDb()
    db.setRows('user', [])
    const repo = new UserRepository(db as unknown as PostgresDatabase)
    await repo.query().paginate({ page: 4, perPage: 10 })
    const select = nonNull(
      db.queries.find((q) => /SELECT .* FROM "user"/i.test(q.sql) && q.sql.includes('LIMIT')),
    )
    expect(select.sql).toContain('LIMIT 10')
    expect(select.sql).toContain('OFFSET 30')
  })

  test('totalPages is 0 when there are no rows', async () => {
    const db = new SpyDb()
    db.setRows('user', [])
    const repo = new UserRepository(db as unknown as PostgresDatabase)
    const page = await repo.query().paginate({ page: 1, perPage: 10 })
    expect(page.total).toBe(0)
    expect(page.totalPages).toBe(0)
  })

  test('runs the main SELECT and the COUNT(*) in parallel (both queries observed)', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    const repo = new UserRepository(db as unknown as PostgresDatabase)
    await repo.query().paginate({ page: 1, perPage: 10 })
    expect(db.queries.some((q) => q.sql.includes('LIMIT 10'))).toBe(true)
    expect(db.queries.some((q) => /COUNT\(\*\)/i.test(q.sql))).toBe(true)
  })

  test('throws on invalid page / perPage', async () => {
    const repo = new UserRepository(new SpyDb() as unknown as PostgresDatabase)
    await expect(repo.query().paginate({ page: 0, perPage: 10 })).rejects.toThrow(
      /positive integer/,
    )
    await expect(repo.query().paginate({ page: 1, perPage: 0 })).rejects.toThrow(/positive integer/)
    await expect(repo.query().paginate({ page: 1.5, perPage: 10 })).rejects.toThrow(
      /positive integer/,
    )
  })

  test('honors .with(...) — eager-loads on the page result type', async () => {
    const db = new SpyDb()
    db.setRows('user', [
      { id: 'u1', email: 'a@b.com', created_at: new Date(), updated_at: new Date() },
    ])
    db.setRows('post', [
      { id: 'p1', title: 'P', user_id: 'u1', created_at: new Date(), updated_at: new Date() },
    ])
    const registry = new SchemaRegistry().registerAll([userSchema, postSchema])
    const repo = new UserRepository(db as unknown as PostgresDatabase, undefined, registry)
    const result: PaginatedResult<User> = await repo
      .query()
      .with('posts')
      .paginate({ page: 1, perPage: 10 })
    expect(result.data[0]?.posts).toHaveLength(1)
  })
})
