import { describe, expect, test } from 'bun:test'

import {
  AuthError,
  AuthorizationError,
  asStravError,
  ConfigError,
  ConflictError,
  isStravError,
  NotFoundError,
  RateLimitError,
  ServerError,
  StravError,
  ValidationError,
} from '../src/exceptions/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Base shape
// ─────────────────────────────────────────────────────────────────────────────

describe('StravError (via ValidationError)', () => {
  test('is an Error instance and inherits the message', () => {
    const e = new ValidationError('email is required')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(StravError)
    expect(e.message).toBe('email is required')
  })

  test('name is the concrete subclass name', () => {
    expect(new ValidationError().name).toBe('ValidationError')
    expect(new NotFoundError().name).toBe('NotFoundError')
    expect(new ConflictError().name).toBe('ConflictError')
  })

  test('exposes default code and status', () => {
    const e = new ValidationError()
    expect(e.code).toBe('validation-error')
    expect(e.status).toBe(422)
  })

  test('options.code overrides the subclass default', () => {
    const e = new ConflictError('email taken', { code: 'user.email-taken' })
    expect(e.code).toBe('user.email-taken')
    expect(e.status).toBe(409) // status stays subclass-fixed
  })

  test('context is captured, copied, and frozen', () => {
    const ctx = { field: 'email', value: 'bad' }
    const e = new ValidationError('bad', { context: ctx })
    expect(e.context).toEqual(ctx)
    // mutating the source after construction must not bleed in
    ctx.field = 'changed'
    expect(e.context.field).toBe('email')
    expect(Object.isFrozen(e.context)).toBe(true)
  })

  test('context defaults to an empty frozen object', () => {
    const e = new NotFoundError()
    expect(e.context).toEqual({})
    expect(Object.isFrozen(e.context)).toBe(true)
  })

  test('cause is preserved (ES2022 Error.cause)', () => {
    const cause = new Error('db down')
    const e = new ServerError('failed to read', { cause })
    expect(e.cause).toBe(cause)
  })

  test('cause may be any value, not only Error', () => {
    const e = new ServerError('weird', { cause: 'string cause' })
    expect(e.cause).toBe('string cause')
  })

  test('captureStackTrace omits the StravError constructor frame', () => {
    const e = new NotFoundError()
    // The stack should reference this test file, not strav_error.ts.
    expect(e.stack).toContain('exceptions.test.ts')
  })

  test('isStravError type-guards correctly', () => {
    expect(isStravError(new ValidationError())).toBe(true)
    expect(isStravError(new Error('plain'))).toBe(false)
    expect(isStravError('not an error')).toBe(false)
    expect(isStravError(null)).toBe(false)
    expect(isStravError(undefined)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// toJSON
// ─────────────────────────────────────────────────────────────────────────────

describe('toJSON', () => {
  test('returns name, code, status, message; omits empty context', () => {
    const json = new NotFoundError('user not found').toJSON()
    expect(json).toEqual({
      name: 'NotFoundError',
      code: 'not-found',
      status: 404,
      message: 'user not found',
    })
    expect('context' in json).toBe(false)
  })

  test('includes context when non-empty', () => {
    const json = new NotFoundError('user not found', { context: { id: 42 } }).toJSON()
    expect(json.context).toEqual({ id: 42 })
  })

  test('round-trips through JSON.stringify', () => {
    const e = new ConflictError('email taken', { context: { email: 'a@b.c' } })
    const parsed = JSON.parse(JSON.stringify(e))
    expect(parsed).toEqual({
      name: 'ConflictError',
      code: 'conflict',
      status: 409,
      message: 'email taken',
      context: { email: 'a@b.c' },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Subclass status + code matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('subclass defaults', () => {
  const cases: Array<[new () => StravError, string, number]> = [
    [ValidationError, 'validation-error', 422],
    [AuthError, 'auth-error', 401],
    [AuthorizationError, 'authorization-error', 403],
    [NotFoundError, 'not-found', 404],
    [ConflictError, 'conflict', 409],
    [RateLimitError, 'rate-limited', 429],
    [ServerError, 'server-error', 500],
  ]

  for (const [Class, code, status] of cases) {
    test(`${Class.name}: code=${code}, status=${status}`, () => {
      const e = new Class()
      expect(e.code).toBe(code)
      expect(e.status).toBe(status)
    })
  }

  test('ConfigError: code=config-error, status=500 (requires message)', () => {
    const e = new ConfigError('missing database.url')
    expect(e.code).toBe('config-error')
    expect(e.status).toBe(500)
    expect(e.message).toBe('missing database.url')
  })

  test('every subclass supplies a sensible default message', () => {
    expect(new ValidationError().message).toBe('Validation failed.')
    expect(new AuthError().message).toBe('Authentication required.')
    expect(new AuthorizationError().message).toBe('You are not authorized to perform this action.')
    expect(new NotFoundError().message).toBe('Resource not found.')
    expect(new ConflictError().message).toBe('Resource conflict.')
    expect(new RateLimitError().message).toBe('Too many requests.')
    expect(new ServerError().message).toBe('Internal server error.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ValidationError specifics
// ─────────────────────────────────────────────────────────────────────────────

describe('ValidationError', () => {
  test('captures field errors and freezes the map + arrays', () => {
    const e = new ValidationError('Validation failed.', {
      errors: { email: ['required', 'invalid format'], password: ['too short'] },
    })
    expect(e.errors).toEqual({
      email: ['required', 'invalid format'],
      password: ['too short'],
    })
    expect(Object.isFrozen(e.errors)).toBe(true)
    expect(Object.isFrozen(e.errors.email)).toBe(true)
  })

  test('defaults errors to an empty frozen map', () => {
    const e = new ValidationError()
    expect(e.errors).toEqual({})
    expect(Object.isFrozen(e.errors)).toBe(true)
  })

  test('mutating the source errors map after construction has no effect', () => {
    const src: Record<string, string[]> = { email: ['required'] }
    const e = new ValidationError('Validation failed.', { errors: src })
    src.email = ['changed']
    src.password = ['added']
    expect(e.errors.email).toEqual(['required'])
    expect('password' in e.errors).toBe(false)
  })

  test('toJSON includes errors', () => {
    const json = new ValidationError('Validation failed.', {
      errors: { email: ['required'] },
    }).toJSON()
    expect(json).toEqual({
      name: 'ValidationError',
      code: 'validation-error',
      status: 422,
      message: 'Validation failed.',
      errors: { email: ['required'] },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RateLimitError specifics
// ─────────────────────────────────────────────────────────────────────────────

describe('RateLimitError', () => {
  test('retryAfter defaults to undefined and is omitted from JSON', () => {
    const e = new RateLimitError()
    expect(e.retryAfter).toBeUndefined()
    expect('retryAfter' in e.toJSON()).toBe(false)
  })

  test('retryAfter is captured and surfaced in toJSON', () => {
    const e = new RateLimitError('slow down', { retryAfter: 30 })
    expect(e.retryAfter).toBe(30)
    expect(e.toJSON().retryAfter).toBe(30)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// asStravError
// ─────────────────────────────────────────────────────────────────────────────

describe('asStravError', () => {
  test('returns StravError subclass instances unchanged', () => {
    const original = new ValidationError('bad')
    expect(asStravError(original)).toBe(original)
  })

  test('wraps plain Error in ServerError preserving message and cause', () => {
    const cause = new Error('boom')
    const wrapped = asStravError(cause)
    expect(wrapped).toBeInstanceOf(ServerError)
    expect(wrapped.message).toBe('boom')
    expect(wrapped.cause).toBe(cause)
  })

  test('wraps non-Error values in ServerError with fallback message', () => {
    const wrapped = asStravError('string thrown', 'something went wrong')
    expect(wrapped).toBeInstanceOf(ServerError)
    expect(wrapped.message).toBe('something went wrong')
    expect(wrapped.cause).toBe('string thrown')
  })

  test('falls back to default message when Error has no message', () => {
    const wrapped = asStravError(new Error(''), 'wrap fallback')
    expect(wrapped.message).toBe('wrap fallback')
  })

  test('uses default fallback message when none is provided', () => {
    expect(asStravError(null).message).toBe('Internal server error.')
  })
})
