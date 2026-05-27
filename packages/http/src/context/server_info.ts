/**
 * Parse a Bun `Request` (+ optional `X-Forwarded-*` from a trusted proxy) into
 * the `ServerInfo` shape exposed on `ctx.server`.
 *
 * `appDomain` is the configured registrable apex — everything before it is the
 * subdomain. There is no PSL lookup; "set appDomain correctly for `co.uk`"
 * is on the operator.
 */

import type { ServerInfo } from './types.ts'

export interface BuildServerInfoOptions {
  request: Request
  /** Optional per-request client IP (Bun's `server.requestIP(request)?.address`). */
  ip?: string
  /** Registrable apex; everything before it is the subdomain. */
  appDomain?: string
  /** When true, trust `X-Forwarded-Host` / `X-Forwarded-Proto` from this request. */
  trustProxy?: boolean
}

export function buildServerInfo(opts: BuildServerInfoOptions): ServerInfo {
  const headers = opts.request.headers
  const hostHeader =
    (opts.trustProxy ? headers.get('x-forwarded-host') : null) ?? headers.get('host') ?? ''

  const url = new URL(opts.request.url)
  const proxyProto = opts.trustProxy
    ? headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    : undefined
  const protocol: 'http' | 'https' =
    proxyProto === 'http' || proxyProto === 'https'
      ? proxyProto
      : url.protocol === 'https:'
        ? 'https'
        : 'http'

  const [hostname, portStr] = splitHostPort(hostHeader || url.host)
  const port = portStr ? Number(portStr) : undefined

  const { domain, subdomain } = splitDomain(hostname, opts.appDomain)

  const info: ServerInfo = {
    host: hostHeader || url.host,
    hostname,
    domain,
    protocol,
    ip: opts.ip ?? '',
    userAgent: headers.get('user-agent') ?? '',
  }
  if (port !== undefined) info.port = port
  if (subdomain !== undefined) info.subdomain = subdomain
  return info
}

function splitHostPort(host: string): [string, string | undefined] {
  // IPv6 literals are wrapped in brackets; the port (if any) follows ']:'.
  if (host.startsWith('[')) {
    const closing = host.indexOf(']')
    if (closing === -1) return [host, undefined]
    const hostname = host.slice(0, closing + 1)
    const rest = host.slice(closing + 1)
    if (rest.startsWith(':')) return [hostname, rest.slice(1)]
    return [hostname, undefined]
  }
  const colon = host.indexOf(':')
  if (colon === -1) return [host, undefined]
  return [host.slice(0, colon), host.slice(colon + 1)]
}

function splitDomain(
  hostname: string,
  appDomain: string | undefined,
): { domain: string; subdomain: string | undefined } {
  if (!appDomain || appDomain.length === 0) {
    return { domain: hostname, subdomain: undefined }
  }
  if (hostname === appDomain) {
    return { domain: appDomain, subdomain: undefined }
  }
  const suffix = `.${appDomain}`
  if (hostname.endsWith(suffix)) {
    return {
      domain: appDomain,
      subdomain: hostname.slice(0, -suffix.length),
    }
  }
  return { domain: hostname, subdomain: undefined }
}
