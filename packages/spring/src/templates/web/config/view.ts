import { env } from '@strav/kernel'
import type { ViewConfig } from '@strav/view'

export default {
  directory: 'resources/views',
  cache: env('APP_ENV', 'local') === 'production',

  // CSS bundling — `view:build` reads each input, walks `@import`s
  // via Bun's CSS bundler, and writes to `outputDir`. The layout's
  // `@css` directive emits the matching `<link rel="stylesheet">`.
  css: {
    inputs: ['resources/css/app.css'],
    outputDir: 'public/assets',
    linkPath: 'app.css',
  },

  // Asset versioning for `@asset` / `@css`. `publicDir` mirrors the
  // layout under `/assets/...` so `app.css` resolves to a file at
  // `public/assets/app.css` and a URL at `/assets/app.css`.
  // Versioning is mtime-based by default; drop a
  // `public/assets/manifest.json` to switch to fingerprinted
  // filenames.
  assets: {
    publicDir: 'public/assets',
    prefix: '/assets/',
  },

  pages: {
    autoRoute: true,
  },
} satisfies ViewConfig
