/**
 * `HttpRequest` — the read-side surface of `ctx.request`.
 *
 * Wraps a Bun `Request`. Body access methods (`json`, `form`, `body`, `input`)
 * cache the parsed result so calling them more than once is safe; the
 * underlying `Request.body` stream is consumed only once.
 */

import type { HttpRequestApi } from './types.ts'

const JSON_ACCEPTS = ['application/json', 'application/*+json']

export class HttpRequest implements HttpRequestApi {
  readonly raw: Request
  readonly method: string
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string | string[]>>
  readonly headers: Headers
  readonly cookies: Readonly<Record<string, string>>

  private parsedBody: { value: unknown } | undefined
  // FormData type drift between Bun/undici makes a precise type painful here;
  // we round-trip through the runtime value and cast at the boundary.
  // biome-ignore lint/suspicious/noExplicitAny: see note above
  private parsedForm: any

  constructor(raw: Request, params: Readonly<Record<string, string>> = {}) {
    this.raw = raw
    this.method = raw.method
    this.url = new URL(raw.url)
    this.params = params
    this.query = parseQuery(this.url.searchParams)
    // Headers are exposed mutable (per Bun's runtime), but documented as
    // read-only for handler code — write via `ctx.response.header(...)`.
    this.headers = raw.headers
    this.cookies = parseCookies(raw.headers.get('cookie'))
  }

  get path(): string {
    return this.url.pathname
  }

  async body(): Promise<unknown> {
    if (this.parsedBody) return this.parsedBody.value
    const ct = this.raw.headers.get('content-type') ?? ''
    let value: unknown
    if (ct.includes('application/json')) {
      value = await this.raw.json().catch(() => null)
    } else if (
      ct.includes('application/x-www-form-urlencoded') ||
      ct.includes('multipart/form-data')
    ) {
      const form = await this.raw.formData()
      this.parsedForm = form
      value = formToObject(form as FormData)
    } else if (ct.startsWith('text/')) {
      value = await this.raw.text()
    } else if (ct.length === 0) {
      value = null
    } else {
      value = await this.raw.arrayBuffer()
    }
    this.parsedBody = { value }
    return value
  }

  async json<T = unknown>(): Promise<T> {
    const body = await this.body()
    return body as T
  }

  async form(): Promise<FormData> {
    if (this.parsedForm) return this.parsedForm as FormData
    // If `body()` already consumed the stream as something other than form,
    // we can't recover — return empty FormData rather than throwing.
    if (this.parsedBody && !this.parsedForm) return new FormData()
    const form = await this.raw.formData()
    this.parsedForm = form
    return form as FormData
  }

  async file(name: string): Promise<File | null> {
    const form = await this.form()
    const value = form.get(name)
    return value instanceof File ? value : null
  }

  async input<T = unknown>(name?: string): Promise<T | undefined | Record<string, unknown>> {
    const body = await this.body()
    if (name === undefined) {
      return isPlainObject(body) ? body : {}
    }
    if (isPlainObject(body) && name in body) {
      return body[name] as T
    }
    const fromQuery = this.url.searchParams.get(name)
    if (fromQuery !== null) return fromQuery as unknown as T
    return undefined
  }

  accepts(types: readonly string[]): string | false {
    const accept = this.raw.headers.get('accept')
    if (!accept) return types[0] ?? false
    const offered = accept
      .split(',')
      .map((s) => s.split(';')[0]?.trim())
      .filter(Boolean) as string[]
    for (const type of types) {
      if (offered.some((o) => matchesAccept(o, type))) return type
    }
    return false
  }

  wantsJson(): boolean {
    const accept = this.raw.headers.get('accept') ?? ''
    if (accept.length === 0) return false
    return JSON_ACCEPTS.some((t) => accept.includes(t)) || accept.includes('*/*')
  }

  isMethod(method: string): boolean {
    return this.method.toUpperCase() === method.toUpperCase()
  }

  hasHeader(name: string): boolean {
    return this.raw.headers.has(name)
  }
}

function parseQuery(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of params.keys()) {
    const all = params.getAll(key)
    if (key in out) continue
    out[key] = all.length > 1 ? all : (all[0] as string)
  }
  return out
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    if (key.length === 0) continue
    const value = pair.slice(idx + 1).trim()
    out[key] = decodeURIComponent(value)
  }
  return out
}

function formToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key)
    out[key] = all.length > 1 ? all : all[0]
  }
  return out
}

function matchesAccept(offered: string, type: string): boolean {
  if (offered === type) return true
  if (offered === '*/*') return true
  const [oType, oSub] = offered.split('/')
  const [tType, tSub] = type.split('/')
  if (oSub === '*' && oType === tType) return true
  if (oType === '*' && oSub === tSub) return true
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
