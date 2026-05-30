/**
 * `MailInboundError` — typed error raised by inbound webhook parsers when
 * the payload itself is malformed (bad JSON, wrong content-type, missing
 * required fields).
 *
 * For signature / signing-key failures, parsers throw `AuthError` from
 * `@strav/kernel`. For misconfiguration at construction time, they throw
 * `ConfigError`.
 *
 * Carry the upstream provider's HTTP status (the one the parser would
 * return to the provider's webhook delivery system) under `context.status`.
 * The error's own `status` is fixed at 400 — the inbound webhook delivered
 * something we could not parse.
 */

import { StravError, type StravErrorOptions } from '@strav/kernel'

export class MailInboundError extends StravError {
  constructor(message: string, options: StravErrorOptions = {}) {
    super(message, { code: 'mail-inbound-error', status: 400 }, options)
  }
}
