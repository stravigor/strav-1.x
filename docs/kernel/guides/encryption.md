# Encryption

`@strav/kernel` ships a small symmetric encryption primitive: an abstract `Cipher` class, a concrete `AesGcm256Cipher` (AES-256-GCM via `node:crypto`), and an `EncryptionProvider` that wires both into the DI container from `config.encryption.key`.

The primary consumer is `@strav/database`'s `@encrypt` decorator, which makes encryption-at-rest a per-field annotation on Models. The primitives are framework-internal but exposed so future packages (queue payloads, sealed events) can reuse the same key + algorithm without adding another crypto stack.

## Setup

Two pieces — config + provider:

```ts
// config/encryption.ts
import { env } from '@strav/kernel'

export default {
  // 32 bytes. Hex (64 chars) or base64 (44 chars padded). Generate with:
  //   openssl rand -hex 32
  key: env.required('ENCRYPTION_KEY'),
}
```

```ts
// bootstrap/providers.ts
import { ConfigProvider, EncryptionProvider } from '@strav/kernel'
import encryptionConfig from '../config/encryption.ts'

export default [
  new ConfigProvider({ encryption: encryptionConfig, /* ... */ }),
  new EncryptionProvider(),
]
```

`EncryptionProvider` declares `'config'` as a dependency, so order it after `ConfigProvider`. It boots eagerly — a malformed key (wrong length, bad encoding) throws `ConfigError` at `app.start()` rather than on the first encrypted write.

## Cipher contract

```ts
class Cipher {
  encrypt(plaintext: string): Uint8Array
  decrypt(ciphertext: Uint8Array): string
}
```

The base `Cipher` class is constructable but its `encrypt`/`decrypt` both throw `ConfigError` with `code: 'encryption.not-configured'`. This lets the DI container resolve `cipher?: Cipher` for any consumer even when `EncryptionProvider` isn't registered — the throw only fires if something actually tries to use it. Apps without encryption never trip it.

`AesGcm256Cipher extends Cipher` is the concrete implementation. Storage layout:

```
| iv (12B random) | tag (16B GCM) | ciphertext (≥0B) |
```

The IV is fresh per encrypt call (AES-GCM's security model requires it). Identical plaintexts encrypt to different ciphertexts each time. The 128-bit auth tag detects tampering — a flipped bit or a wrong key throws at `decipher.final()` instead of silently decrypting garbage.

## Key formats

`parseEncryptionKey(raw)` accepts:

- **64-char hex** matching `/^[0-9a-fA-F]{64}$/` — what `openssl rand -hex 32` outputs.
- **base64** decoding to exactly 32 bytes (44 chars padded, 43 unpadded) — what `openssl rand -base64 32` outputs.
- **32-byte `Uint8Array` / `Buffer`** — for tests or env-loaded binary.

Anything else throws `ConfigError` — failing at boot beats accidentally deriving a 16-byte key from a typo.

## Using the cipher directly

Inject `Cipher` like any other service:

```ts
import { inject, Cipher } from '@strav/kernel'

@inject()
class TokenService {
  constructor(private readonly cipher: Cipher) {}

  sealToken(payload: string): string {
    return Buffer.from(this.cipher.encrypt(payload)).toString('base64url')
  }

  openToken(sealed: string): string {
    return this.cipher.decrypt(Buffer.from(sealed, 'base64url'))
  }
}
```

For the common case — encrypting database columns — use `@encrypt` from `@strav/database`. See [docs/database/guides/model_decorators.md](../../database/guides/model_decorators.md).

## Key rotation

Add the old key to `config.encryption.previousKeys` and swap `key` to the new value. Encryption always uses the current `key`; decryption tries `key` first, then each `previousKeys[]` in order, returning the first success. The ciphertext envelope didn't change — old data keeps decrypting without re-writing every row.

```ts
// config/encryption.ts
export default {
  key:           env.required('APP_KEY'),         // current
  previousKeys: [env('APP_KEY_PREVIOUS')].filter(Boolean), // rotate-out
}
```

Cycle:

1. Generate a new key. Set `APP_KEY_PREVIOUS=<old>`, `APP_KEY=<new>`. Deploy.
2. New writes encrypt under the new key. Reads of old rows succeed via `previousKeys` fallback.
3. (Optional) Run a re-encrypt-on-read migration: `SELECT … UPDATE` cycle that round-trips encrypted columns. Once every row is under the new key, drop `APP_KEY_PREVIOUS`.

There's no "key id" header in the envelope. Decryption is `O(keyRing.length)` per ciphertext when the current key fails — typically a single retry after a rotation, until the migration completes.

## Blind index — searching encrypted columns

`cipher.blindIndex(plaintext)` returns a deterministic HMAC-SHA256 of the plaintext under the current key, as a 64-char hex string. Pair it with an `_index` sidecar column to query encrypted fields by equality:

```ts
// schema
defineSchema('user', Archetype.Entity, (t) => {
  t.id()
  t.encrypted('email')                       // ciphertext column
  t.string('email_index').max(64).unique()  // sidecar — the HMAC hex
  t.timestamps()
})

// write
const email = 'alice@example.com'
await users.create({ email, email_index: cipher.blindIndex(email) })

// look up
const user = await users.query()
  .where('email_index', cipher.blindIndex(searchTerm))
  .first()
```

Properties:

- **Deterministic** — same plaintext under the same key always hashes to the same index, so an equality query on the sidecar matches.
- **Keyed** — observers without the key can't pre-compute a hash table to reverse the index. (Plain SHA-256 would let them.)
- **Always uses the current key** — rotation invalidates the index. After rotation, the old index column won't match a `blindIndex(plaintext)` computed under the new key. Either: (a) rehash + update the sidecar in your re-encrypt-on-read migration, or (b) leave `previousKeys` populated and compute index lookups under both keys until the migration finishes.

## What's deferred

- **Per-tenant keys.** Same key for the whole app today.
- **Async / HSM-backed ciphers.** The `Cipher` interface is synchronous, which keeps the Repository hot path tight. Async-capable ciphers (KMS, HSM) would need a parallel `AsyncCipher` interface; not part of V1.

## Edge cases

- **Empty strings** round-trip correctly (`encrypt('')` produces a 28-byte blob — iv + tag + 0-byte ciphertext).
- **Multi-byte UTF-8** is handled natively (the encoder is `'utf8'` on both sides).
- **Wrong key** throws on `decrypt`. There's no "warn" mode — the auth tag check is binary.
- **Ciphertext shorter than 28 bytes** throws `ConfigError` (`encryption.bad-ciphertext`) before even invoking the decipher.
