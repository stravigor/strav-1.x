import type { App } from 'vue'

/**
 * Shared setup for every Vue island on the page. Runs once on the single
 * `createApp(Root)` that the `@strav/view` islands bundler produces, so
 * plugins (Pinia, vue-router, i18n, …) and global directives go here.
 *
 * Export a default function. The bundler invokes it with the app instance.
 */
export default (app: App): void => {
  // Example: app.use(createPinia())
  void app
}
