# Logger — channels, redaction, request-scope

The kernel's logger is a thin wrapper around [Pino](https://getpino.io/). It enforces a few Strav conventions — channels, path-based redaction, structured fields — while keeping Pino's JSON wire format intact.

## The flow

```
config/logger.ts (typed config)
   │
   ▼
LoggerProvider.register()  → binds LogManager + Logger
LoggerProvider.boot()      → constructs the manager (fail-fast on bad config)
   │
   ▼
Logger (default channel)   → resolved via @inject() or c.resolve(Logger)
   │
   ▼
log.info('msg', { …fields })  → redact → Pino → channel destination(s)
```

## Configuring channels

```ts
// config/logger.ts
import { env } from '@strav/kernel'
import type { LoggerConfig } from '@strav/kernel'

const config: LoggerConfig = {
  default: env('LOG_CHANNEL', 'stack'),
  level:   env('LOG_LEVEL', 'info'),
  channels: {
    stack:  { driver: 'stack',  children: ['stderr', 'daily'] },
    stderr: { driver: 'stderr', pretty: !import.meta.env?.PROD },
    daily:  { driver: 'daily',  path: 'storage/logs/app.log', days: 14 },
    single: { driver: 'single', path: 'storage/logs/single.log' },
    // syslog ships in M4 — configuring it today throws ConfigError at boot.
  },
  redact: {
    paths: ['password', '**.token', 'headers.authorization', 'cookie', 'set-cookie'],
    censor: '[REDACTED]',
  },
}

export default config
```

Add it to your provider list:

```ts
// bootstrap/providers.ts
import { ConfigProvider, LoggerProvider } from '@strav/kernel'
import loggerConfig from '../config/logger.ts'

export default [
  new ConfigProvider({ logger: loggerConfig }),
  new LoggerProvider(),
]
```

`LoggerProvider` depends on `'config'`, so the topo-sort always wires it up after `ConfigProvider`.

## Drivers

| Driver | Destination | When to use |
|---|---|---|
| `stderr`  | `process.stderr`; optional `pretty: true` for local-dev formatting | Default, container-friendly |
| `single`  | Append to a single file | Dev or when external rotation (logrotate) handles cleanup |
| `daily`   | One file per UTC day (`app-YYYY-MM-DD.log`); prunes files older than `days` at boot | In-process rotation without external tooling |
| `stack`   | Fan one event out to multiple child channels | "stderr + file" is the common pairing |
| `syslog`  | Planned for M4; throws `ConfigError` today | — |

`daily`'s rotation strategy is intentionally simple: no in-process timers, no fsync dance. Suitable for low-to-mid volume — high-throughput services should lean on the OS or a syslog channel instead.

## Levels

| Level | Use |
|---|---|
| `trace` | Very high-frequency diagnostic; off in prod |
| `debug` | Diagnostic; off in prod |
| `info`  | Lifecycle, request log, job log |
| `warn`  | Recoverable abnormal state |
| `error` | Exception surfaces to the user, breaks a request or job |
| `fatal` | Process should exit |
| `silent` | No emission — useful for dynamic-level callers |

Each channel may override the global `level`. Anything below the channel's level is dropped before the destination's `write()` runs.

## Calling the logger

```ts
import { Logger, inject } from '@strav/kernel'

@inject()
class AuthController {
  constructor(private log: Logger) {}

  signIn(userId: string, ip: string): void {
    this.log.info('user.signed_in', { userId, ip })
  }
}
```

The first argument is always the **event identifier** (snake/dot-case is conventional). The second is the structured fields. Pino auto-attaches `time`, `level`, `pid`, `hostname`.

### Dynamic levels

```ts
log.log(severity, 'upstream.event', { …fields })
// `severity` may be any LogLevel including 'silent' (no-op)
```

### Child loggers (request scope)

`log.child(context)` returns a new logger pre-bound to extra fields:

```ts
const requestLog = log.child({ requestId, userId, tenantId })
requestLog.info('http.handled', { status: 200, duration_ms: 23 })
```

The parent is unaffected. HTTP middleware (M2 follow-up) injects a request-scoped child into the per-request container scope so controllers resolve the correlated logger automatically.

### Switching channels

```ts
log.channel('syslog').error('intrusion.detected', { …fields })
```

`channel()` is only available on loggers built by a `LogManager` (the normal case). A logger constructed directly throws `ConfigError` on `channel()`.

## Redaction

Path expressions in `redact.paths` match field paths anywhere in the structured-fields object. Supported syntax:

| Pattern | Matches |
|---|---|
| `password` | The literal `password` key at any depth where the pattern reaches it (root-only when used alone) |
| `headers.authorization` | Exact nested path |
| `*.password` | One wildcard segment, then `password` |
| `**.token` | Any number of segments, then `token` |

Matched values are replaced with `censor` (default `[REDACTED]`). Redaction:

- Runs **before** Pino serializes — destinations never see the original value.
- Returns a **clone** — the caller's object is never mutated.
- Walks objects + arrays. Non-plain objects (Date, Buffer, Error) are passed through untouched.

Bake the common-secret defaults into every app's redact list — at minimum `password`, `**.token`, `headers.authorization`, `cookie`, `set-cookie`.

## Lifecycle

- **`LoggerProvider.boot()`** constructs the manager. Misconfiguration (unknown driver, bad level, cyclic stack, missing child) throws `ConfigError` here, not at the first log call.
- **`LoggerProvider.shutdown()`** flushes and closes every file destination opened by any channel that was resolved. Safe to call even if no log line was ever written.

## Error serialization

Pino's `err` serializer is wired for both `err` and `error` fields:

```ts
catch (cause) {
  log.error('http.unhandled', { err: cause })
}
```

→ produces structured `{type, message, stack, ...cause-chain}` instead of `"[object Object]"`.

## What's NOT here

- **A central error-code registry** — codes are throw-site declarations, not enums.
- **Auto translation of `code` → human messages** — apps handle that in their `ExceptionHandler.renderHttp`.
- **`pino-pretty` integration** — the built-in `pretty: true` mode uses a tiny in-process formatter to keep `@strav/kernel`'s dependency surface to Pino only.
