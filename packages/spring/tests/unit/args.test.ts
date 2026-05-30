import { describe, expect, test } from 'bun:test'
import { parseArgs, toSnakeCase } from '../../src/args.ts'
import { SpringError } from '../../src/spring_error.ts'

describe('parseArgs', () => {
  test('parses a project name positional', () => {
    const a = parseArgs(['my-app'])
    expect(a.projectName).toBe('my-app')
    expect(a.template).toBeUndefined()
    expect(a.help).toBe(false)
    expect(a.version).toBe(false)
    expect(a.noInstall).toBe(false)
  })

  test('--api and --web set the template', () => {
    expect(parseArgs(['my-app', '--api']).template).toBe('api')
    expect(parseArgs(['my-app', '--web']).template).toBe('web')
  })

  test('-t/--template alias accepts api|web', () => {
    expect(parseArgs(['my-app', '-t', 'api']).template).toBe('api')
    expect(parseArgs(['my-app', '--template', 'web']).template).toBe('web')
  })

  test('-t with bad value throws', () => {
    expect(() => parseArgs(['my-app', '-t', 'lol'])).toThrow(SpringError)
  })

  test('--api and --web together throws', () => {
    expect(() => parseArgs(['my-app', '--api', '--web'])).toThrow(SpringError)
  })

  test('--db captures next token', () => {
    expect(parseArgs(['my-app', '--db', 'custom_db']).dbName).toBe('custom_db')
  })

  test('--db without value throws', () => {
    expect(() => parseArgs(['my-app', '--db'])).toThrow(SpringError)
  })

  test('--help and -h set help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  test('--version and -v set version', () => {
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  test('--no-install sets noInstall', () => {
    expect(parseArgs(['my-app', '--no-install']).noInstall).toBe(true)
  })

  test('unknown option throws', () => {
    expect(() => parseArgs(['my-app', '--frob'])).toThrow(SpringError)
  })

  test('second positional throws', () => {
    expect(() => parseArgs(['a', 'b'])).toThrow(SpringError)
  })

  test('uppercase / invalid project names rejected', () => {
    expect(() => parseArgs(['MyApp'])).toThrow(SpringError)
    expect(() => parseArgs(['-my'])).toThrow(SpringError) // looks like an option
    expect(() => parseArgs(['my app'])).toThrow(SpringError) // space → looks like two args
    expect(() => parseArgs(['.hidden'])).toThrow(SpringError)
  })
})

describe('toSnakeCase', () => {
  test('hyphens become underscores', () => {
    expect(toSnakeCase('my-blog')).toBe('my_blog')
  })
  test('runs of non-alphanumerics collapse', () => {
    expect(toSnakeCase('my--co.app')).toBe('my_co_app')
  })
  test('leading/trailing separators trimmed', () => {
    expect(toSnakeCase('--abc--')).toBe('abc')
  })
  test('already snake-case is preserved', () => {
    expect(toSnakeCase('hello_world')).toBe('hello_world')
  })
})
