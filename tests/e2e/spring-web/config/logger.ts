import { env } from '@strav/kernel'

export default {
  default: 'stderr',
  level: env('LOG_LEVEL', 'info'),
  channels: {
    stderr: { driver: 'stderr' },
  },
}
