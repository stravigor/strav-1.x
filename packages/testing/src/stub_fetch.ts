/**
 * Typed `fetch` stub for driver tests that need to assert on outgoing
 * HTTP without a network round-trip.
 *
 * Adapters that take a `fetch` injection point (e.g. `LineSocialDriver`,
 * pure-fetch brain drivers) typically end up with `as unknown as typeof
 * fetch` boilerplate in tests because the standard `fetch` signature
 * (with `preconnect`, etc.) doesn't match a plain async function.
 * `stubFetch` confines that cast to one place.
 *
 * ```ts
 * import { stubFetch } from '@strav/testing'
 *
 * const captured: Request[] = []
 * const driver = new LineSocialDriver({
 *   config: { ... },
 *   fetch: stubFetch(async (req) => {
 *     captured.push(req)
 *     if (req.url.includes('/token')) {
 *       return Response.json({ access_token: 'AT_1', expires_in: 3600 })
 *     }
 *     return new Response('not found', { status: 404 })
 *   }),
 * })
 * ```
 *
 * The handler receives a `Request` regardless of how the caller invoked
 * `fetch` (URL + init, URL string, existing Request). Normalization
 * happens here so the handler doesn't have to branch on input shape.
 */

export type FetchHandler = (request: Request) => Response | Promise<Response>

export function stubFetch(handler: FetchHandler): typeof fetch {
  const fn = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const request = normalizeToRequest(input, init)
    return handler(request)
  }
  return fn as unknown as typeof fetch
}

function normalizeToRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Request {
  if (input instanceof Request) {
    // If `init` is provided, the spec says we layer it on; new Request
    // accepts (Request, RequestInit) and merges accordingly.
    return init === undefined ? input : new Request(input, init)
  }
  // string | URL → construct a Request. URL converts via its toString.
  return new Request(typeof input === 'string' ? input : input.toString(), init)
}
