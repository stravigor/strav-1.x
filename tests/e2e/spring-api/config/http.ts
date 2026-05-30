import { env } from '@strav/kernel'

export default {
  /**
   * Expose stack traces in error responses. Convenient locally; never
   * leave this on in production.
   */
  exposeStackTrace: env('APP_ENV', 'local') !== 'production',
}
