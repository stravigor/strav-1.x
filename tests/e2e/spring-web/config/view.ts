import { env } from '@strav/kernel'
import type { ViewConfig } from '@strav/view'

export default {
  directory: 'resources/views',
  cache: env('APP_ENV', 'local') === 'production',
  islandsDir: 'resources/ts/islands',
  islandsOut: 'public/assets/islands',
  pages: {
    autoRoute: true,
  },
} satisfies ViewConfig
