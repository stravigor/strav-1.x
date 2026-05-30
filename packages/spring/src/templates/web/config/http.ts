import { env } from '@strav/kernel'

export default {
  /**
   * Expose stack traces in error responses. Convenient locally; never
   * leave this on in production.
   */
  exposeStackTrace: env('APP_ENV', 'local') !== 'production',
  /**
   * Static-asset root. GET / HEAD requests that no route handles fall
   * through to a file lookup under this directory before the 404 path
   * runs. Path traversal (`..`) is rejected by the kernel.
   *
   * `bun strav view:build` writes the islands bundle into
   * `public/assets/islands/` — make sure your stylesheet build does the
   * same so the layout's `<link rel="stylesheet" href="/assets/app.css">`
   * resolves.
   */
  publicDir: 'public',
}
