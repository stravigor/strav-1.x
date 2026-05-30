# Building an adapter

How to ship a driver — Stripe-equivalent, Qdrant-equivalent, Anthropic-equivalent — for one of Strav's manager+drivers packages (`@strav/payment`, `@strav/social`, `@strav/brain`, `@strav/rag`).

For the package-shape primer (subsystem vs manager+drivers, directory layout, `ServiceProvider` contract), read [implementing-a-package.md](./implementing-a-package.md) first. This doc picks up where it leaves off: you've decided you're writing a driver, and you need to know the registration patterns, the SDK-in-config gotcha, the tests to copy, and the right place for the file to land.

## The shape

Every manager+drivers package exports a driver interface — `PaymentDriver`, `SocialDriver`, `BrainDriver`, `VectorStore`. Your adapter implements that interface and ships in `src/drivers/<vendor>/<vendor>_<name>_driver.ts`. Co-located in the vendor subdir:

- `<vendor>_config.ts` — the vendor-specific config shape (extends the package's `ProviderConfig` discriminated union via `driver: '<name>'`).
- `<vendor>_provider.ts` — a `ServiceProvider` that registers the driver factory with the manager (when shipping as part of an adapter package, not when extending an app's own bootstrap).
- `<vendor>_helpers.ts`, `<vendor>_message_builder.ts`, `<vendor>_response_mapper.ts`, `<vendor>_webhook.ts` — split as needed. See `@strav/payment/drivers/stripe/` for the canonical large-driver layout.

Capability matrix: some interfaces are wide (`PaymentDriver` has ~60 ops; few vendors implement them all). Declare what you support via `capabilities: ReadonlySet<...>` and throw `ProviderUnsupportedError` synchronously on the ops you don't. Apps that check the capability first avoid the throw; apps that don't get a fail-fast.

## Registration — two patterns

```ts
// 1. Factory registration. Apps declare the driver in config; the manager
//    constructs it on first resolve. This is the common case — apps switch
//    backends by editing `config/<name>.ts`.
manager.extend('qdrant', (config) => new QdrantDriver(config))

// 2. Hand-wired instance. The driver is constructed somewhere else (test
//    harness, ad-hoc script, integration with a wider system) and you want
//    it under a name.
manager.useDriver('qdrant-test', driverInstance)
```

`extend()` is the right call from a vendor adapter package's `ServiceProvider.register()` — it makes the driver opt-in via config. `useDriver()` / `useStore()` is the right call when the driver lives outside the manager-pattern entirely (one-off scripts, tests that stub the SDK).

| Package | Factory registration | Hand-wire registration |
|---|---|---|
| `@strav/payment` | `payment.extend(name, factory)` | `payment.useDriver(name, driver)` |
| `@strav/social` | `social.extend(name, factory)` | `social.useDriver(name, driver)` |
| `@strav/brain` | `brain.extend(name, driver)` (driver instance, not factory) | n/a — `extend` already takes the instance |
| `@strav/rag` | `rag.extend(name, factory)` | `rag.useStore(name, store)` |

## Vendor SDK ≠ config

**Most-cited adapter gotcha.** The kernel's `ConfigRepository` deep-clones every value when constructed. A pre-instantiated vendor SDK (e.g. `new Stripe(secret)`) holds cyclic refs — agent pools, event emitters, internal config trees that point back at themselves — and the recursive clone hits a stack overflow.

```ts
// ❌ Causes a stack-overflow at boot when ConfigRepository clones the tree.
export default {
  default: 'stripe',
  providers: {
    stripe: {
      driver: 'stripe',
      client: new Stripe(env('STRIPE_SECRET')),   // ← cyclic refs inside
    },
  },
}
```

Config is for cloneable data only: strings, numbers, booleans, plain objects, arrays. The kernel's deep clone exists so frozen-after-boot semantics are enforceable and so providers can safely retain references to their config slice. There's no way to declare "don't clone this branch" because that would leak the mutation surface.

The right places to put an SDK instance:

```ts
// ✅ Apps that want a pre-configured SDK pass it via the driver constructor's
//    `options` arg and register the result with the manager.
//
//    config/payment.ts → only credentials (clonable).
//    bootstrap/providers.ts → wires the SDK + driver into the manager.

export default {
  default: 'stripe',
  providers: {
    stripe: {
      driver: 'stripe',
      secret: env('STRIPE_SECRET'),
      webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    },
  },
}

// bootstrap/providers.ts
class CustomStripeProvider extends ServiceProvider {
  override readonly dependencies = ['payment']
  override boot(app: Application): void {
    const payment = app.resolve(PaymentManager)
    const stripeClient = new Stripe(env('STRIPE_SECRET'), { ...customRetry })
    payment.useDriver('stripe', new StripePaymentDriver({
      instanceName: 'stripe',
      config: app.resolve(ConfigRepository).get('payment.providers.stripe'),
      client: stripeClient,        // ← injected, never cloned
    }))
  }
}
```

For a vendor adapter package shipping its `ServiceProvider`, the equivalent pattern is `clientFactory: () => SDK` — apps pass a function that returns the SDK; the factory runs at first resolve, outside the config clone. Stripe and Omise drivers both accept an explicit `client` constructor option for this.

If your custom driver needs the SDK instance for tests but production should construct it from credentials, mirror that shape: `constructor(args: { instanceName, config, client?: SDK })`. Tests pass `client: stub`. Production omits `client` and the constructor builds one from `config.secret`.

## Writing the driver

Mechanical steps:

1. **Find the driver interface.** It's named `<Package>Driver` and exported from the package barrel. The interface docstring lists what each method must return and what blocking guarantees it owes the caller.
2. **Decide capabilities up front.** Look at the interface — every op you can't implement becomes a `ProviderUnsupportedError` throw. The capability set lives on the driver instance so apps can branch via `manager.use(name).capabilities.has('subscriptions.create')`.
3. **Set up the config type.** Add a discriminated-union entry to the package's `ProviderConfig`: `interface QdrantStoreConfig extends StoreConfig { driver: 'qdrant'; url: string; apiKey: string }`. Vendor adapter packages keep this in `<vendor>_config.ts` next to the driver.
4. **Write the driver class.** Implement the interface. Vendor-specific request shaping and response mapping go in sibling files (`<vendor>_message_builder.ts`, `<vendor>_response_mapper.ts`) when the driver is large enough to be worth splitting — see `@strav/brain/drivers/openai/` for the pattern.
5. **Register from a `ServiceProvider`.** Vendor adapter packages ship one. Apps writing an in-tree adapter call `manager.extend(name, factory)` from their existing service-provider's `boot()`.

```ts
// src/drivers/qdrant/qdrant_provider.ts (vendor adapter package shape)
import { ServiceProvider, type Application } from '@strav/kernel'
import { RagManager } from '@strav/rag'
import { QdrantDriver } from './qdrant_driver.ts'

export class QdrantRagProvider extends ServiceProvider {
  override readonly name = 'rag.qdrant'
  override readonly dependencies = ['rag']

  override boot(app: Application): void {
    const rag = app.resolve(RagManager)
    rag.extend('qdrant', (config) => new QdrantDriver(config as QdrantStoreConfig))
  }
}
```

## Webhooks (payment + social drivers)

If the vendor delivers webhooks:

- Implement `verify(rawBody, signature)` — throw `WebhookSignatureError` (not a generic `Error`) when the signature doesn't match.
- Implement `normalize(event)` — translate the vendor's event shape into the framework's closed event-type union. Unknown event types map to `'unknown'` and surface the raw payload in `event.raw` so apps can opt in to handling.
- Declare the signature header name. The webhook dispatcher (`paymentWebhook()`, `socialWebhook()`) reads it from a known list — add yours via the driver capability map.

## Tests

Three layers of test, in increasing fidelity:

```ts
// Unit — stub the SDK. Useful for asserting request-shape translation.
import { describe, test, expect } from 'bun:test'
import { stubFetch } from '@strav/testing'  // shipping in a later release; copy the pattern in the meantime
import { QdrantDriver } from '../src/drivers/qdrant/qdrant_driver.ts'

test('upsert sends documents as application/json', async () => {
  const calls: { url: string; body: unknown }[] = []
  const driver = new QdrantDriver({
    driver: 'qdrant',
    url: 'https://qdrant.test',
    apiKey: 'x',
    fetchImpl: stubFetch((req) => {
      calls.push({ url: req.url, body: req.json() })
      return new Response('{}', { status: 200 })
    }),
  })
  await driver.upsert('articles', [{ id: '1', content: 'hi', embedding: [0.1] }])
  expect(calls[0].url).toBe('https://qdrant.test/collections/articles/points')
})
```

```ts
// Integration — real backend, self-skip when unavailable. Mirrors the
// `isPostgresAvailable()` pattern documented in implementing-a-package.md.
if (!await isQdrantAvailable()) {
  test.skip('integration: round-trips a query', () => {})
} else {
  // real upsert + real query, assert end-to-end.
}
```

```ts
// E2E — composed at the per-milestone test directory. Boot an app with the
// adapter, run an HTTP-shaped request, assert the response. See
// `tests/e2e/m5-rag/` for the rag-side template.
```

## Files to land

For an in-tree adapter inside the user app:

```
my-app/src/lib/rag-qdrant/
├── qdrant_driver.ts          # implements VectorStore
├── qdrant_config.ts          # extends StoreConfig
└── qdrant_provider.ts        # ServiceProvider that calls rag.extend(...)
```

For a vendor adapter package on npm:

```
packages/<vendor-adapter>/
├── src/
│   ├── index.ts
│   └── drivers/<vendor>/
│       ├── index.ts
│       ├── <vendor>_<package>_driver.ts
│       ├── <vendor>_config.ts
│       ├── <vendor>_provider.ts
│       └── ...
├── tests/...
└── package.json              # peerDependencies: ["@strav/<host-package>"]
```

The host package (`@strav/rag`, `@strav/payment`, etc.) is a `peerDependency`, not a direct dep — your adapter version-tracks the host without forcing apps onto a specific release.

## When in doubt

1. **Open the canonical reference driver.** `@strav/payment/drivers/stripe/` for a large vendor SDK + webhooks. `@strav/brain/drivers/openai/` for a large vendor SDK + tool loops. `@strav/rag/drivers/memory/` for the smallest possible driver.
2. **Read the host package's `<name>_driver.ts`.** It's the contract. The docstring explains what the manager expects.
3. **Don't put the SDK in config.** Repeating because it bites every contributor at least once.
