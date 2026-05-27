# Configuration — patterns and recipes

Configuration in Strav is **code**. There is no manifest format. Every `config/*.ts` file exports a default typed object; the kernel merges them into a `ConfigRepository` at boot. After `app:booted` fires, the repository is frozen.

## The flow

```
.env (read by Bun)
   │
   ▼
config/*.ts files (read with env() helper)
   │
   ▼
bootstrap/providers.ts (constructs ConfigProvider({...}))
   │
   ▼
ConfigRepository (bound under 'config')
   │
   │ app.start() runs providers...
   ▼
app:booted fires → ConfigProvider freezes config
   │
   ▼
runtime: read-only via ConfigRepository.get()
```

## Writing a config file

```ts
// config/database.ts
import { env } from '@strav/kernel'

export default {
  client:   'postgres' as const,
  host:     env('DB_HOST', '127.0.0.1'),
  port:     env.int('DB_PORT', 5432),
  username: env.required('DB_USER'),
  password: env.required('DB_PASSWORD'),
  database: env.required('DB_DATABASE'),
  pool:     { min: 2, max: 20 },
}
```

`env()` reads `process.env` at config-evaluation time. Bun reads `.env` into `process.env` automatically. Each config file is a regular TypeScript module — type-checked, lintable, refactor-able.

## Wiring config into `bootstrap/providers.ts`

```ts
// bootstrap/providers.ts
import { ConfigProvider } from '@strav/kernel'

import appConfig      from '../config/app.ts'
import databaseConfig from '../config/database.ts'
import httpConfig     from '../config/http.ts'

export default [
  new ConfigProvider({
    app:      appConfig,
    database: databaseConfig,
    http:     httpConfig,
  }),
  // ... other providers
]
```

The top-level keys (`app`, `database`, `http`) become the dotted-path prefix when reading: `config.get('database.host')`.

## Reading config

### From a service / repository (DI'd)

```ts
import { inject } from '@strav/kernel'
import { ConfigRepository } from '@strav/kernel'

@inject()
class Database {
  constructor(private config: ConfigRepository) {}

  connect() {
    const host = this.config.get<string>('database.host')!
    const port = this.config.get<number>('database.port', 5432)
    // ...
  }
}
```

### From a provider's `register()` / `boot()`

```ts
class HttpProvider extends ServiceProvider {
  readonly name = 'http'
  readonly dependencies = ['config']

  register(app: Application): void {
    const config = app.resolve(ConfigRepository).section<HttpConfig>('http')
    app.singleton(HttpKernel, () => new HttpKernel(config))
  }
}
```

### From a test / one-off script

```ts
import { app } from '../bootstrap/app.ts'
await app.start({ signalHandlers: false })

const config = app.resolve(ConfigRepository)
console.log(config.get('app.name'))
```

## Read API

| Method | Returns | Behaviour |
|---|---|---|
| `get(key)` | `unknown` | Path or undefined |
| `get<T>(key, default)` | `T` | Default returned when path missing |
| `has(key)` | `boolean` | True if path resolves to a non-undefined value |
| `section<T>(key)` | `T` | Typed sub-tree; **throws** if missing — use when section is required |
| `all()` | `ConfigData` | Deep-cloned snapshot |

Dotted paths walk nested objects: `config.get('database.tenant.bypass.username')` → `data.database.tenant.bypass.username`.

Falsy values (`0`, `''`, `false`) are returned as-is. Defaults only kick in when the path resolves to `undefined`.

## Freeze contract

The repository is **mutable during boot, frozen after**. Two phases:

```
register() / boot() ─── (mutable) ──→ app:booted ─── (frozen) ──→ runtime
```

- During `register()` and `boot()`: `config.set(...)` works. Providers can derive computed values, env-conditional overrides, etc.
- The instant `app:booted` is emitted: `ConfigProvider`'s listener runs first (it's bound to register first), and calls `config.freeze()`. Subsequent `set()` calls throw.
- All other `app:booted` listeners and the rest of the process run against the frozen config.

This guarantees: **what the request handler sees is what the provider saw at the end of boot.** No mid-flight mutations.

## Environment-conditional configuration

There is no `config.production.ts` vs `config.staging.ts`. Conditional logic lives inside the config file:

```ts
// config/logger.ts
import { env } from '@strav/kernel'

const isProd = env('APP_ENV') === 'production'

export default {
  level: env('LOG_LEVEL') ?? (isProd ? 'info' : 'debug'),
  channels: {
    stack:  { driver: 'stack',  children: isProd ? ['stderr', 'syslog'] : ['stderr', 'daily'] },
    stderr: { driver: 'stderr', pretty: !isProd },
  },
  redact: ['password', 'token', 'authorization', 'cookie'],
}
```

All env-dependent logic in one place, type-checked.

## env() helper

```ts
import { env } from '@strav/kernel'

env('NAME')                          // string | undefined
env('NAME', 'fallback')              // string
env.int('PORT', 3000)                // number; throws on non-integer
env.bool('DEBUG', false)             // boolean; throws on unrecognised
env.list('IPS', ['*'])               // string[]; comma-separated, trimmed
env.required('APP_KEY')              // string; throws if missing or empty
```

**Use only in `config/*.ts`.** Services depend on `ConfigRepository`, not `process.env`. Reading env at runtime defeats the freeze contract.

## Type-safe sections

For a typed view of a config tree, declare the type next to the file and pass it to `section<T>`:

```ts
// config/database.ts
export interface DbConfig {
  host: string
  port: number
  pool: { min: number; max: number }
}

const config: DbConfig = {
  host: env('DB_HOST', '127.0.0.1'),
  port: env.int('DB_PORT', 5432),
  pool: { min: 2, max: 20 },
}

export default config
```

```ts
const db = app.resolve(ConfigRepository).section<DbConfig>('database')
db.pool.max  // typed: number
```

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `Error [config.frozen]: cannot set "x"` | Code called `set()` after `app:booted` fired | Move the mutation into a provider's `boot()` |
| `Error: env.required("APP_KEY"): missing` | Required env var not set | Set in `.env`, or use `env('APP_KEY')` if optional |
| `Error: env.int("PORT"): not a valid integer` | Env var contains non-integer | Fix the env value, or use `env('PORT')` if you want raw string |
| `config.get('foo')` returns the wrong value in tests | A previous test mutated `process.env` after config was built | Set env vars BEFORE constructing the test app |
| Provider can't read config | Provider's `dependencies` doesn't include `'config'` | Add `readonly dependencies = ['config']` |
| Config changes between requests | Don't try this in 1.0 — use `@strav/flag` for runtime toggles | See `@strav/flag` (lands M5) |
