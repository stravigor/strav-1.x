import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetManifest, ViewEngine } from '../src/index.ts'

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'asset-mf-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('AssetManifest', () => {
  test('manifest hit — strav-flat shape', async () => {
    await withTmp(async (publicDir) => {
      await writeFile(
        join(publicDir, 'manifest.json'),
        JSON.stringify({ 'css/app.css': 'css/app.abc123.css' }),
      )
      const m = new AssetManifest({ publicDir })
      expect(m.version('css/app.css')).toBe('/css/app.abc123.css')
    })
  })

  test('manifest hit — vite shape ({ file })', async () => {
    await withTmp(async (publicDir) => {
      await writeFile(
        join(publicDir, 'manifest.json'),
        JSON.stringify({
          'src/main.ts': { file: 'assets/main.deadbe.js', src: 'src/main.ts' },
        }),
      )
      const m = new AssetManifest({ publicDir })
      expect(m.version('src/main.ts')).toBe('/assets/main.deadbe.js')
    })
  })

  test('no manifest — falls back to ?v=<mtime> when the file exists on disk', async () => {
    await withTmp(async (publicDir) => {
      await writeFile(join(publicDir, 'app.js'), 'console.log(1)')
      const m = new AssetManifest({ publicDir })
      const out = m.version('app.js')
      expect(out).toMatch(/^\/app\.js\?v=[0-9a-f]+$/)
    })
  })

  test('no manifest, no file — returns prefix + path', async () => {
    await withTmp(async (publicDir) => {
      const m = new AssetManifest({ publicDir })
      expect(m.version('missing.css')).toBe('/missing.css')
    })
  })

  test('absolute URLs and protocol-relative URLs pass through unchanged', async () => {
    const m = new AssetManifest()
    expect(m.version('https://cdn.example.com/x.js')).toBe('https://cdn.example.com/x.js')
    expect(m.version('//cdn.example.com/x.js')).toBe('//cdn.example.com/x.js')
  })

  test('prefix is normalised and prepended', async () => {
    await withTmp(async (publicDir) => {
      await writeFile(
        join(publicDir, 'manifest.json'),
        JSON.stringify({ 'css/app.css': 'css/app.abc.css' }),
      )
      const m = new AssetManifest({ publicDir, prefix: 'https://cdn.example.com' })
      expect(m.version('css/app.css')).toBe('https://cdn.example.com/css/app.abc.css')
    })
  })

  test('reload() drops cached resolutions', async () => {
    await withTmp(async (publicDir) => {
      const manifestPath = join(publicDir, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({ 'a.css': 'a.111.css' }))
      const m = new AssetManifest({ publicDir })
      expect(m.version('a.css')).toBe('/a.111.css')
      await writeFile(manifestPath, JSON.stringify({ 'a.css': 'a.222.css' }))
      // Cached — still old.
      expect(m.version('a.css')).toBe('/a.111.css')
      m.reload()
      expect(m.version('a.css')).toBe('/a.222.css')
    })
  })
})

describe('ViewEngine — @asset wires through AssetManifest', () => {
  test('manifest entry replaces the @asset path', async () => {
    await withTmp(async (publicDir) => {
      await writeFile(
        join(publicDir, 'manifest.json'),
        JSON.stringify({ 'css/app.css': 'css/app.deadbe.css' }),
      )
      const engine = new ViewEngine({
        config: { directory: '/views', assets: { publicDir } },
        read: async () => "@asset('css/app.css')",
      })
      expect(await engine.render('any')).toBe('/css/app.deadbe.css')
    })
  })
})
