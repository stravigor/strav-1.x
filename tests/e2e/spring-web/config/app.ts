import { env } from '@strav/kernel'

export default {
  name: env('APP_NAME', 'spring-web'),
  env: env('APP_ENV', 'local'),
  /**
   * Encryption + signing key. Generate one with `bun strav key:generate`
   * and copy the value into `.env`. The placeholder below is fine for
   * `bun strav serve` smoke-tests but MUST be replaced before deploying.
   */
  key: env('APP_KEY', 'change-me-with-key-generate'),
  url: env('APP_URL', 'http://localhost:3000'),
}
