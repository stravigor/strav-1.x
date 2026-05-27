import { Application } from '@strav/kernel'

import { providers } from './providers.ts'

export function createApp(): Application {
  const app = new Application()
  app.useProviders(providers())
  return app
}
