/**
 * `route(name, params?, options?)` — resolve a named route to a URL string.
 *
 * Takes the router instance explicitly so this stays a plain function — the
 * common `import { route } from '@strav/http'` form is a thin wrapper that
 * resolves the router from the container at call time (provided by
 * `HttpProvider`).
 *
 * Missing params throw `ConfigError`. Extra params append to the query string
 * (in declaration order, since the spec says nothing about deterministic
 * sorting here).
 */

import { ConfigError } from '@strav/kernel'
import type { Router } from './router.ts'

export interface ResolveOptions {
  /** When true, prepend `protocol://host` (caller supplies via `host`/`protocol`). */
  abs?: boolean
  host?: string
  protocol?: 'http' | 'https'
}

export function resolveRoute(
  router: Router,
  name: string,
  params: Record<string, string | number | undefined> = {},
  options: ResolveOptions = {},
): string {
  const route = router.named(name)
  if (!route) {
    throw new ConfigError(`route(): unknown name "${name}".`)
  }

  const segments = route.pattern.split('/')
  const consumed = new Set<string>()
  const out: string[] = []

  for (const seg of segments) {
    if (seg.startsWith(':')) {
      const optional = seg.endsWith('?')
      const paramName = optional ? seg.slice(1, -1) : seg.slice(1)
      const value = params[paramName]
      consumed.add(paramName)
      if (value === undefined || value === null || value === '') {
        if (optional) continue
        throw new ConfigError(`route("${name}"): missing param "${paramName}".`)
      }
      out.push(encodeURIComponent(String(value)))
      continue
    }
    if (seg.startsWith('*')) {
      const paramName = seg.slice(1)
      const value = params[paramName]
      consumed.add(paramName)
      if (value === undefined || value === null) {
        throw new ConfigError(`route("${name}"): missing wildcard "${paramName}".`)
      }
      // Wildcards pass through "/" unencoded; encode the rest piecewise.
      out.push(
        String(value)
          .split('/')
          .map((p) => encodeURIComponent(p))
          .join('/'),
      )
      continue
    }
    out.push(seg)
  }

  let path = out.join('/')
  if (!path.startsWith('/')) path = `/${path}`

  // Extra params → query string.
  const queryEntries: Array<[string, string]> = []
  for (const [k, v] of Object.entries(params)) {
    if (consumed.has(k)) continue
    if (v === undefined || v === null) continue
    queryEntries.push([k, String(v)])
  }
  if (queryEntries.length > 0) {
    const qs = queryEntries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    path += `?${qs}`
  }

  if (options.abs) {
    const protocol = options.protocol ?? 'https'
    const host = options.host
    if (!host) {
      throw new ConfigError(`route("${name}"): abs: true requires options.host.`)
    }
    return `${protocol}://${host}${path}`
  }

  return path
}
