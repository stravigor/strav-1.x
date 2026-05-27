/**
 * Read environment variables with typed coercion + safe defaults.
 *
 * **Use only in `config/*.ts` files.** Services should depend on
 * `ConfigRepository`, not read `process.env` at runtime.
 *
 * Bun reads `.env` automatically into `process.env`; these helpers read from
 * `process.env`. Reading happens at config-load time — once the
 * `ConfigRepository` is built and frozen, subsequent `process.env` mutations
 * are not picked up.
 *
 * @example
 * ```ts
 * import { env } from '@strav/kernel'
 *
 * export default {
 *   name:   env('APP_NAME', 'my-app'),
 *   port:   env.int('PORT', 3000),
 *   debug:  env.bool('DEBUG', false),
 *   trusted: env.list('TRUSTED_IPS'),
 *   key:    env.required('APP_KEY'),
 * }
 * ```
 */

/** A truthy env value, case-insensitive. */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'y'])
/** A falsy env value, case-insensitive. */
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'n', ''])

interface EnvFn {
  /**
   * Read a string env var. Returns `defaultValue` (or `undefined`) when unset
   * or empty.
   */
  (name: string): string | undefined
  (name: string, defaultValue: string): string

  /** Read an integer. Throws if the value is set but not a valid integer. */
  int(name: string): number | undefined
  int(name: string, defaultValue: number): number

  /** Read a boolean. Recognises `1/true/yes/on/y` and `0/false/no/off/n`. */
  bool(name: string): boolean | undefined
  bool(name: string, defaultValue: boolean): boolean

  /** Read a comma-separated list. Trims each item, drops empties. */
  list(name: string): string[] | undefined
  list(name: string, defaultValue: string[]): string[]

  /** Read a required string. Throws if unset or empty. */
  required(name: string): string
}

function readRaw(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  return raw
}

function getString(name: string): string | undefined
function getString(name: string, defaultValue: string): string
function getString(name: string, defaultValue?: string): string | undefined {
  const raw = readRaw(name)
  if (raw === undefined || raw === '') return defaultValue
  return raw
}

const envImpl = getString as EnvFn

envImpl.int = ((name: string, defaultValue?: number): number | undefined => {
  const raw = readRaw(name)
  if (raw === undefined || raw === '') return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(
      `env.int(${JSON.stringify(name)}): value ${JSON.stringify(raw)} is not a valid integer.`,
    )
  }
  return parsed
}) as EnvFn['int']

envImpl.bool = ((name: string, defaultValue?: boolean): boolean | undefined => {
  const raw = readRaw(name)
  if (raw === undefined) return defaultValue
  const lower = raw.toLowerCase().trim()
  if (TRUE_VALUES.has(lower)) return true
  if (FALSE_VALUES.has(lower)) return false
  throw new Error(
    `env.bool(${JSON.stringify(name)}): value ${JSON.stringify(raw)} is not a recognised boolean ` +
      `(use one of: 1/0, true/false, yes/no, on/off, y/n, or leave empty).`,
  )
}) as EnvFn['bool']

envImpl.list = ((name: string, defaultValue?: string[]): string[] | undefined => {
  const raw = readRaw(name)
  if (raw === undefined || raw === '') return defaultValue
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}) as EnvFn['list']

envImpl.required = (name: string): string => {
  const raw = readRaw(name)
  if (raw === undefined || raw === '') {
    throw new Error(
      `env.required(${JSON.stringify(name)}): missing or empty. Set ${name} in .env or your ` +
        `process environment.`,
    )
  }
  return raw
}

export const env = envImpl
export type { EnvFn }
