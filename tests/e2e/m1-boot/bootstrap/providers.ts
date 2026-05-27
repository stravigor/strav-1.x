import { ConfigProvider, type ServiceProvider } from '@strav/kernel'

import appConfig from '../config/app.ts'
import loggerConfig from '../config/logger.ts'

export function providers(): ServiceProvider[] {
  return [
    new ConfigProvider({
      app: appConfig,
      logger: loggerConfig,
    }),
  ]
}
