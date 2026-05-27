/**
 * `Router` — collects route declarations, then compiles them into a `RouteTrie`
 * for runtime matching.
 *
 * The router is a *registry* during `routes/*.ts` loading and a *matcher* once
 * `compile()` runs. Calls to `get`/`post`/etc. after compile throw — the
 * compiled trie is frozen at that point.
 *
 * Group state (prefix / middleware / name) is stacked: nested groups
 * concatenate prefixes, append middleware, and concatenate names. See
 * `spec/http.md`.
 *
 * Named routes are tracked in a flat map keyed by the final composed name.
 * The `route(name, params)` resolver lives in `route_resolver.ts`.
 */

import { ConfigError } from '@strav/kernel'
import { Route } from './route.ts'
import { type MatchResult, RouteTrie } from './trie.ts'
import type { CompiledRoute, HttpMethod, RouteGroupOptions, RouteHandler } from './types.ts'

interface GroupState {
  prefix: string
  middleware: readonly string[]
  name: string
}

const EMPTY_GROUP: GroupState = { prefix: '', middleware: [], name: '' }

export class Router {
  private readonly routes: Array<{ route: Route; group: GroupState }> = []
  private trie: RouteTrie | undefined
  private nameIndex: Map<string, CompiledRoute> | undefined
  private groupStack: GroupState[] = [EMPTY_GROUP]

  // ─── Verbs ─────────────────────────────────────────────────────────────────
  // The `T` generic is inferred from tuple handlers so the method-name slot is
  // type-checked against the controller class. Plain closures / single-action
  // classes default `T` to `unknown` and don't exercise the inference.

  get<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('GET', pattern, handler as RouteHandler)
  }
  post<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('POST', pattern, handler as RouteHandler)
  }
  put<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('PUT', pattern, handler as RouteHandler)
  }
  patch<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('PATCH', pattern, handler as RouteHandler)
  }
  delete<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('DELETE', pattern, handler as RouteHandler)
  }
  options<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('OPTIONS', pattern, handler as RouteHandler)
  }
  head<T = unknown>(pattern: string, handler: RouteHandler<T>): Route {
    return this.add('HEAD', pattern, handler as RouteHandler)
  }

  /** Register the same handler for every HTTP verb. */
  any<T = unknown>(pattern: string, handler: RouteHandler<T>): Route[] {
    const verbs: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
    return verbs.map((v) => this.add(v, pattern, handler as RouteHandler))
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  /**
   * Run `callback` with group state (prefix / middleware / name) layered on
   * top of the current stack. Nested calls combine — see spec §Groups.
   */
  group(options: RouteGroupOptions, callback: (router: Router) => void): void {
    if (this.trie) {
      throw new ConfigError('Router: cannot add a group after compile().')
    }
    const parent = this.currentGroup()
    const next: GroupState = {
      prefix: joinPrefix(parent.prefix, options.prefix ?? ''),
      middleware: [...parent.middleware, ...normalizeMiddleware(options.middleware)],
      name: parent.name + (options.name ?? ''),
    }
    this.groupStack.push(next)
    try {
      callback(this)
    } finally {
      this.groupStack.pop()
    }
  }

  // ─── Compile + match ───────────────────────────────────────────────────────

  /**
   * Build the trie and the name index. Idempotent: calling it twice is a
   * no-op (the cached trie is reused). Must be called before `match()`.
   */
  compile(): void {
    if (this.trie) return
    const trie = new RouteTrie()
    const nameIndex = new Map<string, CompiledRoute>()
    for (const { route, group } of this.routes) {
      const compiled: CompiledRoute = {
        method: route.method,
        pattern: joinPrefix(group.prefix, route.pattern),
        paramNames: extractParamNames(joinPrefix(group.prefix, route.pattern)),
        handler: route.handler,
        middleware: [...group.middleware, ...route.getMiddleware()],
        name: route.getName() ? group.name + route.getName() : undefined,
      }
      trie.insert(compiled)
      if (compiled.name) {
        if (nameIndex.has(compiled.name)) {
          throw new ConfigError(`Router: duplicate route name "${compiled.name}".`)
        }
        nameIndex.set(compiled.name, compiled)
      }
    }
    this.trie = trie
    this.nameIndex = nameIndex
  }

  /** Look up a route. Compiles the trie on first call if not already compiled. */
  match(method: string, path: string): MatchResult {
    if (!this.trie) this.compile()
    // biome-ignore lint/style/noNonNullAssertion: trie is set by compile()
    return this.trie!.match(method, path)
  }

  /** All registered routes in declaration order, fully composed. */
  list(): readonly CompiledRoute[] {
    if (!this.trie) this.compile()
    return this.routes.map(({ route, group }) => ({
      method: route.method,
      pattern: joinPrefix(group.prefix, route.pattern),
      paramNames: extractParamNames(joinPrefix(group.prefix, route.pattern)),
      handler: route.handler,
      middleware: [...group.middleware, ...route.getMiddleware()],
      name: route.getName() ? group.name + route.getName() : undefined,
    }))
  }

  /**
   * Resolve a named route to its compiled definition. Returns `undefined`
   * when the name is unknown.
   */
  named(name: string): CompiledRoute | undefined {
    if (!this.nameIndex) this.compile()
    return this.nameIndex?.get(name)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private add(method: HttpMethod, pattern: string, handler: RouteHandler): Route {
    if (this.trie) {
      throw new ConfigError(`Router: cannot add ${method} ${pattern} after compile().`)
    }
    const route = new Route(method, normalizePattern(pattern), handler)
    this.routes.push({ route, group: this.currentGroup() })
    return route
  }

  private currentGroup(): GroupState {
    // biome-ignore lint/style/noNonNullAssertion: stack always seeded with EMPTY_GROUP
    return this.groupStack[this.groupStack.length - 1]!
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeMiddleware(value: string | readonly string[] | undefined): string[] {
  if (!value) return []
  if (typeof value === 'string') return [value]
  return [...value]
}

function normalizePattern(pattern: string): string {
  if (pattern.length === 0) return '/'
  return pattern.startsWith('/') ? pattern : `/${pattern}`
}

function joinPrefix(prefix: string, suffix: string): string {
  const a = prefix.replace(/\/+$/, '')
  const b = normalizePattern(suffix).replace(/^\/+/, '/')
  if (a.length === 0) return b
  return `${a}${b}`
}

function extractParamNames(pattern: string): string[] {
  const names: string[] = []
  for (const seg of pattern.split('/')) {
    if (seg.startsWith(':')) {
      const name = seg.endsWith('?') ? seg.slice(1, -1) : seg.slice(1)
      if (name.length > 0) names.push(name)
    } else if (seg.startsWith('*')) {
      names.push(seg.slice(1))
    }
  }
  return names
}
