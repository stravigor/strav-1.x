import { env } from '@strav/kernel'

const host = env('DB_HOST', '127.0.0.1')
const port = env('DB_PORT', '5432')
const user = env('DB_USER', 'strav')
const password = env('DB_PASSWORD', 'strav')
const database = env('DB_DATABASE', 'strav_test')

export default {
  url: `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`,
  max: 4,
  lazyConnect: true,
}
