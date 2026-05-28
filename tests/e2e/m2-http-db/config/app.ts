import { env } from '@strav/kernel'

export default {
  name: env('APP_NAME', 'strav-m2-http-db'),
  env: env('APP_ENV', 'testing'),
  key: env('APP_KEY', 'm2-smoke-test-key'),
}
