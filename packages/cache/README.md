# @strav/cache

Key/value cache with TTLs for Strav 1.0. Apps inject the abstract `Cache` token; the provider in the container picks the concrete driver — `MemoryCache` for single-node dev, `PostgresCache` for multi-node deployments. Same dependency shape as `@strav/broadcast` (kernel-free core in the root, optional Postgres driver under a subpath).

```ts
import { Cache } from '@strav/cache'

@inject()
class LeadsService {
  constructor(private readonly cache: Cache) {}

  async trending(): Promise<Lead[]> {
    return this.cache.remember('leads.trending', '5m', async () => {
      return this.leads.query().orderBy('score', 'desc').limit(10).get()
    })
  }
}
```

Canonical docs live in [`docs/cache/README.md`](../../docs/cache/README.md).

## What ships

| Driver | Subpath | Notes |
|---|---|---|
| Memory | `@strav/cache` (root) + `@strav/cache/memory` | In-process. Bounded buffer; locks + tags first-class. Single-node only. |
| Postgres | `@strav/cache/postgres` | Cross-process backplane via three tables (`strav_cache`, `strav_cache_locks`, `strav_cache_tags`). Atomic increments via row locks, FK cascade keeps tag rows tight. |

The full Cache surface (`get`/`put`/`forget`/`has`/`flush`/`add`/`increment`/`decrement`/`remember`/`rememberForever`/`lock`/`tags`) ships on both drivers; the abstract base provides `remember` + `rememberForever` so every driver behaves identically there. No Redis driver yet — apps that need one write against the `Cache` contract (two abstract methods + the wrapper classes for locks/tags).
