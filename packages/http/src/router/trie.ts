/**
 * Compact path trie. Built once at boot from the router's collected routes.
 *
 * Segments fall into three buckets at each level:
 *   1. **Static** — literal text. Always matched first.
 *   2. **Param** — `:name`. Matches any single non-empty segment.
 *   3. **Wildcard** — `*name`. Matches the rest of the path (must be terminal).
 *
 * Static wins over param wins over wildcard at any given node — that's the
 * "static beats dynamic" precedence the spec calls out.
 *
 * Optional params (`:id?`) are expanded at insertion time into two routes —
 * one with the segment, one without — so the runtime walk stays branch-free.
 *
 * Match result:
 *   - `{ kind: 'found', route, params }` — full match.
 *   - `{ kind: 'method-not-allowed', allowed }` — path matched a handler node
 *     but the method didn't.
 *   - `{ kind: 'not-found' }` — no path match.
 */

import type { CompiledRoute, HttpMethod } from './types.ts'

interface TrieNode {
  staticChildren: Map<string, TrieNode>
  paramChild?: { name: string; node: TrieNode }
  wildcardChild?: { name: string; node: TrieNode }
  handlers: Map<HttpMethod, CompiledRoute>
}

export type MatchResult =
  | { kind: 'found'; route: CompiledRoute; params: Record<string, string> }
  | { kind: 'method-not-allowed'; allowed: HttpMethod[] }
  | { kind: 'not-found' }

export class RouteTrie {
  private readonly root: TrieNode = freshNode()

  /**
   * Insert a compiled route. Optional params (`:id?`) are expanded into two
   * insertions so the trie itself does not have to model optionality.
   */
  insert(route: CompiledRoute): void {
    const expansions = expandOptionalParams(route.pattern)
    for (const pattern of expansions) {
      // The recorded route keeps the *original* pattern so callers see
      // `/users/:id?` rather than `/users` or `/users/:id`. paramNames stay in
      // declaration order — when the optional segment is dropped, that name
      // simply doesn't appear in the matched params object at runtime.
      this.insertExpanded(pattern, route)
    }
  }

  match(method: string, path: string): MatchResult {
    const segments = splitPath(path)
    const found: Array<{ route: CompiledRoute; params: Record<string, string> }> = []
    walk(this.root, segments, 0, {}, found)

    if (found.length === 0) return { kind: 'not-found' }

    const methodUpper = method.toUpperCase() as HttpMethod
    for (const candidate of found) {
      const route = candidate.route.method === methodUpper ? candidate.route : undefined
      if (route) return { kind: 'found', route, params: candidate.params }
    }
    const allowed = [...new Set(found.map((c) => c.route.method))]
    return { kind: 'method-not-allowed', allowed }
  }

  private insertExpanded(pattern: string, route: CompiledRoute): void {
    const segments = splitPath(pattern)
    let cur = this.root

    for (let i = 0; i < segments.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i < length
      const seg = segments[i]!

      if (seg.startsWith('*')) {
        if (i !== segments.length - 1) {
          throw new Error(`Router: wildcard segment "${seg}" must be the last segment.`)
        }
        const name = seg.slice(1)
        if (!cur.wildcardChild) {
          cur.wildcardChild = { name, node: freshNode() }
        } else if (cur.wildcardChild.name !== name) {
          throw new Error(
            `Router: wildcard name conflict — "${cur.wildcardChild.name}" vs "${name}" at "${pattern}".`,
          )
        }
        cur = cur.wildcardChild.node
        continue
      }

      if (seg.startsWith(':')) {
        const name = seg.slice(1)
        if (!cur.paramChild) {
          cur.paramChild = { name, node: freshNode() }
        } else if (cur.paramChild.name !== name) {
          throw new Error(
            `Router: param name conflict — "${cur.paramChild.name}" vs "${name}" at "${pattern}".`,
          )
        }
        cur = cur.paramChild.node
        continue
      }

      let child = cur.staticChildren.get(seg)
      if (!child) {
        child = freshNode()
        cur.staticChildren.set(seg, child)
      }
      cur = child
    }

    // Same (method, pattern) being inserted twice is a real conflict — distinct
    // expansions of one optional pattern always land on different trie nodes,
    // so collision here means a duplicate `router.get('/x', …)` call.
    if (cur.handlers.has(route.method)) {
      throw new Error(`Router: duplicate route ${route.method} ${pattern}`)
    }
    cur.handlers.set(route.method, route)
  }
}

function freshNode(): TrieNode {
  return { staticChildren: new Map(), handlers: new Map() }
}

function splitPath(path: string): string[] {
  // Normalize: leading slash is the root indicator, not a segment.
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed.length === 0) return []
  return trimmed.split('/')
}

/**
 * Walk every viable path through the trie collecting handler-bearing nodes.
 * We collect *all* matches so the caller can pick the right method, falling
 * back to 405 when no method-matching candidate exists. Static branches are
 * tried before param branches before wildcard branches — that's the
 * "static beats dynamic" precedence enforced at walk time, not at insert.
 */
function walk(
  node: TrieNode,
  segments: readonly string[],
  index: number,
  params: Record<string, string>,
  found: Array<{ route: CompiledRoute; params: Record<string, string> }>,
): void {
  if (index === segments.length) {
    if (node.handlers.size > 0) {
      for (const route of node.handlers.values()) {
        found.push({ route, params: { ...params } })
      }
    }
    return
  }

  // biome-ignore lint/style/noNonNullAssertion: index < length
  const seg = segments[index]!

  const staticChild = node.staticChildren.get(seg)
  if (staticChild) walk(staticChild, segments, index + 1, params, found)

  if (node.paramChild && seg.length > 0) {
    const childParams = { ...params, [node.paramChild.name]: decodeURIComponent(seg) }
    walk(node.paramChild.node, segments, index + 1, childParams, found)
  }

  if (node.wildcardChild) {
    const rest = segments
      .slice(index)
      .map((s) => decodeURIComponent(s))
      .join('/')
    const childParams = { ...params, [node.wildcardChild.name]: rest }
    if (node.wildcardChild.node.handlers.size > 0) {
      for (const route of node.wildcardChild.node.handlers.values()) {
        found.push({ route, params: childParams })
      }
    }
  }
}

/**
 * Expand `:id?` into two patterns: with the segment and without it.
 * Cartesian over multiple optional params is supported but discouraged —
 * each adds a factor-of-two to the insert count.
 */
function expandOptionalParams(pattern: string): string[] {
  const segments = splitPath(pattern)
  let patterns: string[][] = [[]]
  for (const seg of segments) {
    if (seg.startsWith(':') && seg.endsWith('?')) {
      const required = seg.slice(0, -1) // drop the `?`
      const withSeg = patterns.map((p) => [...p, required])
      const withoutSeg = patterns.map((p) => [...p])
      patterns = [...withSeg, ...withoutSeg]
    } else {
      patterns = patterns.map((p) => [...p, seg])
    }
  }
  // Prefer the more-specific pattern (more segments) first so it appears
  // earlier in the match-walk — useful only for diagnostics; the trie itself
  // makes precedence deterministic.
  return patterns.map((segs) => (segs.length === 0 ? '/' : `/${segs.join('/')}`))
}
