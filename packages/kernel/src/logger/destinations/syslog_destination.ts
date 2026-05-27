/**
 * Syslog destination — placeholder. A real BSD/RFC 5424 syslog driver lands
 * in M4 alongside the rest of the platform-specific channels. Constructing
 * one now throws `ConfigError` so misconfiguration is loud and immediate
 * rather than silent.
 */

import { ConfigError } from '../../exceptions/config_error.ts'
import type { LogDestination } from './destination.ts'

export function syslogDestination(): LogDestination {
  throw new ConfigError(
    'Logger: the `syslog` driver is not implemented yet (planned for M4). ' +
      'Configure a different channel for now.',
  )
}
