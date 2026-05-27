import { env } from '@strav/kernel'

export default {
  name: env('APP_NAME', 'strav-m1-boot'),
  env: env('APP_ENV', 'testing'),
  key: env('APP_KEY', 'm1-smoke-test-key'),
}
