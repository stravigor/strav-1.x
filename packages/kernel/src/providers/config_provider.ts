/**
 * Binds `ConfigRepository` under the `'config'` key and arranges the
 * freeze-on-`app:booted` contract.
 *
 * Two construction modes:
 *
 *   1. **Auto-discovery** (recommended):
 *      ```ts
 *      const providers = [
 *        await ConfigProvider.fromDirectory('config'),
 *        // ... other providers
 *      ]
 *      ```
 *      Scans `<cwd>/config/*.{ts,js,mts,mjs}`, dynamic-imports each
 *      one, and keys the merged map by file basename. `config/app.ts`
 *      → `config.app.*`, `config/database.ts` → `config.database.*`,
 *      and so on. Files starting with `_` or `.` are skipped.
 *
 *   2. **Explicit map** (back-compat, useful in tests):
 *      ```ts
 *      new ConfigProvider({ app: appConfig, database: dbConfig })
 *      ```
 *      Same shape as before — pass a pre-built `ConfigData` map.
 *
 * `ConfigProvider` is the first provider to register (no deps), so other
 * providers can `c.resolve<ConfigRepository>('config')` in their own
 * `register()` and `boot()` calls.
 */

import { readdir } from 'node:fs/promises'
import { isAbsolute, join, parse as parsePath, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ConfigData, ConfigRepository } from '../config/configuration.ts'
import { type Application, ServiceProvider } from '../core/index.ts'

const CONFIG_FILE_RE = /\.(?:ts|js|mts|mjs|cts|cjs)$/

export interface FromDirectoryOptions {
  /**
   * Directory absolute or relative to `cwd`. Default `'config'`.
   */
  directory?: string
  /**
   * Working directory for resolving a relative `directory`. Defaults
   * to `process.cwd()`. Useful for tests.
   */
  cwd?: string
  /**
   * Extra config to merge on top of the discovered files. Lets apps
   * overlay environment-specific values (e.g. test fixtures) without
   * touching the on-disk `config/` tree.
   */
  overrides?: ConfigData
}

export class ConfigProvider extends ServiceProvider {
  override readonly name = 'config'
  override readonly dependencies = []

  constructor(private readonly data: ConfigData = {}) {
    super()
  }

  /**
   * Scan a directory of config files and return a ready-to-use
   * `ConfigProvider`. Each file's default export becomes one
   * top-level config section keyed by the file's basename.
   *
   * Discovery rules:
   *
   *   - Files matching `*.{ts,js,mts,mjs,cts,cjs}` are imported.
   *   - The default export is read; sections without one are skipped
   *     with a warning written to stderr.
   *   - Files / sub-directories whose name starts with `.` or `_`
   *     are ignored (handy for `_local.ts`, `.draft.ts`, etc.).
   *   - Sub-directories are NOT recursed — keep `config/` flat. Apps
   *     that want nested config compose objects inside one file.
   *
   * Discovery happens in parallel. Errors thrown by a config file's
   * top-level code propagate — config files are expected to be pure
   * (read `env(...)`, return an object) and not throw under normal
   * load.
   */
  static async fromDirectory(
    directoryOrOptions: string | FromDirectoryOptions = 'config',
  ): Promise<ConfigProvider> {
    const opts: FromDirectoryOptions =
      typeof directoryOrOptions === 'string'
        ? { directory: directoryOrOptions }
        : directoryOrOptions
    const cwd = opts.cwd ?? process.cwd()
    const directory = opts.directory ?? 'config'
    const absDir = isAbsolute(directory) ? directory : resolve(cwd, directory)

    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch (cause) {
      throw new Error(
        `ConfigProvider.fromDirectory: could not read '${absDir}'. ${(cause as Error).message}`,
        { cause },
      )
    }

    const candidates = entries.filter(
      (e) =>
        e.isFile() &&
        !e.name.startsWith('.') &&
        !e.name.startsWith('_') &&
        CONFIG_FILE_RE.test(e.name),
    )

    const data: ConfigData = {}
    await Promise.all(
      candidates.map(async (entry) => {
        const path = join(absDir, entry.name)
        const key = parsePath(entry.name).name
        try {
          const mod = (await import(pathToFileURL(path).href)) as {
            default?: unknown
          }
          if (mod.default === undefined) {
            // Skip silently? No — a config file with no default export
            // is almost always a typo. Loud miss with the path.
            process.stderr.write(
              `[ConfigProvider] '${path}' has no default export — skipped.\n`,
            )
            return
          }
          data[key] = mod.default
        } catch (cause) {
          throw new Error(
            `ConfigProvider.fromDirectory: failed to load '${path}'. ${(cause as Error).message}`,
            { cause },
          )
        }
      }),
    )

    if (opts.overrides !== undefined) {
      Object.assign(data, opts.overrides)
    }

    return new ConfigProvider(data)
  }

  override register(app: Application): void {
    const repository = new ConfigRepository(this.data)
    app.singleton('config', () => repository)
    app.singleton(ConfigRepository, () => repository)
  }

  override boot(app: Application): void {
    // ConfigProvider boots first (no deps), so its `once('app:booted', ...)`
    // is the first listener for that event — it runs before any user listener
    // can mutate config.
    app.events.once('app:booted', () => {
      app.resolve(ConfigRepository).freeze()
    })
  }
}
