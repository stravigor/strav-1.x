import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffold } from '../../src/scaffold.ts'

let dest = ''

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spring-test-'))
  dest = join(dir, 'my-app')
})

afterEach(async () => {
  // mkdtemp's parent has only `my-app` inside; remove the parent.
  await rm(join(dest, '..'), { recursive: true, force: true })
})

describe('scaffold(--api)', () => {
  test('writes the expected file set', async () => {
    const result = await scaffold({
      projectName: 'my-app',
      template: 'api',
      dbName: 'my_app',
      dest,
      stravVersion: 'workspace:*',
    })
    // A representative sample — not the whole list — so adding a new
    // template file later doesn't force a snapshot update.
    const expected = [
      '.env',
      '.env.example',
      '.gitignore',
      'README.md',
      'package.json',
      'tsconfig.json',
      'bin/strav.ts',
      'bootstrap/app.ts',
      'bootstrap/providers.ts',
      'config/app.ts',
      'config/http.ts',
      'config/logger.ts',
      'routes/api.ts',
      'routes/console.ts',
      'app/providers/app_provider.ts',
      'tests/feature/healthz.test.ts',
    ]
    for (const file of expected) {
      expect(result.files).toContain(file)
    }
  })

  test('strips _dot_ prefix from path segments', async () => {
    const result = await scaffold({
      projectName: 'my-app',
      template: 'api',
      dbName: 'my_app',
      dest,
      stravVersion: 'workspace:*',
    })
    expect(result.files).toContain('.gitignore')
    expect(result.files).toContain('.env')
    expect(result.files.some((f) => f.includes('_dot_'))).toBe(false)
  })

  test('interpolates {{projectName}}, {{dbName}}, {{stravVersion}}', async () => {
    await scaffold({
      projectName: 'my-blog',
      template: 'api',
      dbName: 'my_blog_db',
      dest,
      stravVersion: '^1.2.3-test',
    })

    const pkg = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('my-blog')
    expect(pkg.dependencies['@strav/kernel']).toBe('^1.2.3-test')
    expect(pkg.dependencies['@strav/http']).toBe('^1.2.3-test')
    expect(pkg.dependencies['@strav/cli']).toBe('^1.2.3-test')

    const env = await readFile(join(dest, '.env'), 'utf8')
    expect(env).toContain('APP_NAME=my-blog')
    expect(env).toContain('DB_DATABASE=my_blog_db')

    const config = await readFile(join(dest, 'config/app.ts'), 'utf8')
    expect(config).toContain(`'my-blog'`) // default APP_NAME falls back to project name
  })

  test('non-.tt files are copied byte-for-byte (no interpolation)', async () => {
    await scaffold({
      projectName: 'my-app',
      template: 'api',
      dbName: 'my_app',
      dest,
      stravVersion: 'workspace:*',
    })
    const tsconfig = JSON.parse(await readFile(join(dest, 'tsconfig.json'), 'utf8'))
    expect(tsconfig.compilerOptions.strict).toBe(true)
    expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true)
  })

  test('the generated tree creates the empty-directory anchors', async () => {
    await scaffold({
      projectName: 'my-app',
      template: 'api',
      dbName: 'my_app',
      dest,
      stravVersion: 'workspace:*',
    })
    // .gitkeep should land at every directory that exists in the spec
    // layout but starts empty.
    for (const dir of [
      'app/console',
      'app/models',
      'app/repositories',
      'database/migrations',
      'database/schemas',
      'storage/cache',
      'storage/logs',
      'storage/uploads',
      'tests/unit',
    ]) {
      const gitkeep = await readFile(join(dest, dir, '.gitkeep')).catch(() => null)
      expect(gitkeep, `${dir}/.gitkeep should exist`).not.toBeNull()
    }
  })
})

describe('scaffold(--web)', () => {
  test('writes shared files plus the web-specific tree', async () => {
    const result = await scaffold({
      projectName: 'my-blog',
      template: 'web',
      dbName: 'my_blog',
      dest,
      stravVersion: 'workspace:*',
    })
    const expected = [
      // From shared/
      'bin/strav.ts',
      'config/app.ts',
      'config/http.ts',
      'config/logger.ts',
      'routes/api.ts',
      // From web/ overlay
      'config/view.ts',
      'routes/web.ts',
      'routes/broadcast.ts',
      'resources/views/layouts/app.strav',
      'resources/views/pages/index.strav',
      'resources/views/errors/404.strav',
      'resources/views/errors/500.strav',
      'resources/css/app.css',
    ]
    for (const file of expected) {
      expect(result.files).toContain(file)
    }
  })

  test('web overlay replaces shared bootstrap/providers + AppProvider + package.json + http config', async () => {
    await scaffold({
      projectName: 'my-blog',
      template: 'web',
      dbName: 'my_blog',
      dest,
      stravVersion: '^1.2.3-web',
    })
    const providers = await readFile(join(dest, 'bootstrap/providers.ts'), 'utf8')
    expect(providers).toContain('ViewProvider')
    expect(providers).toContain('ViewConsoleProvider')

    const appProvider = await readFile(join(dest, 'app/providers/app_provider.ts'), 'utf8')
    expect(appProvider).toContain('registerWebRoutes')
    expect(appProvider).toContain('registerApiRoutes')

    const httpConfig = await readFile(join(dest, 'config/http.ts'), 'utf8')
    expect(httpConfig).toContain(`publicDir: 'public'`)

    const pkg = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@strav/view']).toBe('^1.2.3-web')
    expect(pkg.dependencies.vue).toBeDefined()
    expect(pkg.devDependencies['@vue/compiler-sfc']).toBeDefined()
  })

  test('--web README + .gitignore are the web-flavored overlays', async () => {
    await scaffold({
      projectName: 'my-blog',
      template: 'web',
      dbName: 'my_blog',
      dest,
      stravVersion: 'workspace:*',
    })
    const readme = await readFile(join(dest, 'README.md'), 'utf8')
    expect(readme).toContain('view:build')
    expect(readme).toContain('Vue 3 island')

    const gitignore = await readFile(join(dest, '.gitignore'), 'utf8')
    expect(gitignore).toContain('public/assets/islands/')
  })
})
