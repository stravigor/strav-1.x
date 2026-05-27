/**
 * `HttpContext` — the per-request handle passed to middleware and controllers.
 *
 * Constructed by `HttpKernel` per request:
 *   1. The kernel calls `app.createScope()` to get a request-scoped container.
 *   2. It builds `ServerInfo`, `HttpRequest`, `HttpResponse`.
 *   3. It resolves a child `Logger` correlated to the request (request-id, …).
 *   4. It binds the resulting `HttpContext` into the scope under both the
 *      class key and the `'http.context'` string alias.
 *
 * The constructor parameters mirror the resolved dependencies — *not* the
 * service-locator pattern. Apps never construct `HttpContext` themselves;
 * they receive it via `(ctx) => …` middleware/handlers.
 */

import type { Container, Logger } from '@strav/kernel'
import type {
  AppContextState,
  HttpContext as HttpContextInterface,
  HttpRequestApi,
  HttpResponseApi,
  ServerInfo,
} from './types.ts'

export class HttpContext implements HttpContextInterface {
  readonly server: ServerInfo
  readonly request: HttpRequestApi
  readonly response: HttpResponseApi
  readonly state: AppContextState
  readonly container: Container
  /** Writable — see the interface for why middleware may reassign. */
  log: Logger

  constructor(opts: {
    server: ServerInfo
    request: HttpRequestApi
    response: HttpResponseApi
    container: Container
    log: Logger
    requestId: string
  }) {
    this.server = opts.server
    this.request = opts.request
    this.response = opts.response
    this.container = opts.container
    this.log = opts.log
    this.state = { requestId: opts.requestId } as AppContextState
  }
}
