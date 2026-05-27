/**
 * `Route` — the chainable handle returned by every `router.<method>(...)` call.
 *
 * Holds the per-route mutables — `name`, additional middleware — and surfaces
 * the chainable builder methods. The router records one `Route` per
 * registration; the trie compiler reads its final state at boot.
 */

import type { HttpMethod, RouteHandler } from './types.ts'

export class Route {
  private _name: string | undefined
  private _middleware: string[] = []

  constructor(
    readonly method: HttpMethod,
    readonly pattern: string,
    readonly handler: RouteHandler,
  ) {}

  /** Assign a name for use with the `route(name, params)` resolver. */
  name(value: string): this {
    this._name = value
    return this
  }

  /** Append one or more middleware names. Chainable. */
  middleware(...names: Array<string | readonly string[]>): this {
    for (const n of names) {
      if (typeof n === 'string') this._middleware.push(n)
      else this._middleware.push(...n)
    }
    return this
  }

  /** Returns the assigned name, if any. */
  getName(): string | undefined {
    return this._name
  }

  /** Returns the assigned middleware in declaration order. */
  getMiddleware(): readonly string[] {
    return this._middleware
  }
}
