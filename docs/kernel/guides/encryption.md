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

## What's deferred

- **Key rotation.** V1 is single-key. Multi-key rings with a key-id byte in the ciphertext envelope land in a follow-up — the storage format will have to grow a version prefix at that point.
- **Per-tenant keys.** Same key for the whole app today.
- **Async / HSM-backed ciphers.** The `Cipher` interface is synchronous, which keeps the Repository hot path tight. Async-capable ciphers (KMS, HSM) would need a parallel `AsyncCipher` interface; not part of V1.
- **`@strav/kernel`-owned blind-index helper.** Apps that need searchable encrypted columns currently build their own HMAC-of-canonicalized-plaintext column. A shared helper may land later.

## Edge cases

- **Empty strings** round-trip correctly (`encrypt('')` produces a 28-byte blob — iv + tag + 0-byte ciphertext).
- **Multi-byte UTF-8** is handled natively (the encoder is `'utf8'` on both sides).
- **Wrong key** throws on `decrypt`. There's no "warn" mode — the auth tag check is binary.
- **Ciphertext shorter than 28 bytes** throws `ConfigError` (`encryption.bad-ciphertext`) before even invoking the decipher.
