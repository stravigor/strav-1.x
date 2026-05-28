import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIslands, ViewEngine } from '../src/index.ts'

// ─── ViewEngine.island helper ──────────────────────────────────────────────

describe('ViewEngine — @island helper', () => {
  test('renders a hydration marker WITHOUT a script tag', async () => {
    // Apps add ONE `<script type="module" src="…/islands.js" defer>`
    // to their layout; the directive only emits the marker so a page
    // with multiple islands doesn't get N redundant script tags.
    const engine = new ViewEngine({
      config: { directory: '/views' },
      read: async () => "@island('LeadKanban', { initial: leads })",
    })
    const html = await engine.render('page', { leads: [{ id: 1 }] })
    expect(html).toContain('<div data-island="LeadKanban" data-props="')
    expect(html).toContain('&quot;initial&quot;:[{&quot;id&quot;:1}]')
    expect(html).not.toContain('<script')
  })

  test('escapes HTML-significant chars in island name + props', async () => {
    const engine = new ViewEngine({
      config: { directory: '/views' },
      read: async () => "@island('Foo', { msg: payload })",
    })
    // JSON containing `</script>` MUST be entity-encoded so it can't
    // close the surrounding `<script>` tag in an enclosing layout.
    const html = await engine.render('page', { payload: 'a & b <script>' })
    expect(html).toContain('&quot;msg&quot;:&quot;a &amp; b &lt;script&gt;&quot;')
    expect(html).not.toContain('</script>')
  })

  test('@island with no props passes through an empty object', async () => {
    const engine = new ViewEngine({
      config: { directory: '/views' },
      read: async () => "@island('Plain')",
    })
    const html = await engine.render('page')
    expect(html).toContain('data-props="{}"')
  })

  test('multiple @island directives in one page produce multiple markers', async () => {
    const engine = new ViewEngine({
      config: { directory: '/views' },
      read: async () => "@island('A')@island('B', { id: 1 })",
    })
    const html = await engine.render('page')
    expect(html).toContain('data-island="A"')
    expect(html).toContain('data-island="B"')
    // Only ONE bundle script for the whole page — the engine emits
    // zero. (Apps include it in their layout.)
    expect(html).not.toContain('<script')
  })
})

// ─── buildIslands smoke test against real .vue files ───────────────────────

describe('buildIslands — single-bundle Teleport model', () => {
  let tmpRoot: string
  let inputDir: string
  let outputDir: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'strav-islands-'))
    inputDir = join(tmpRoot, 'islands')
    outputDir = join(tmpRoot, 'out')
    await mkdir(inputDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  test('empty input dir produces empty result', async () => {
    const result = await buildIslands({ inputDir, outputDir })
    expect(result.islands).toEqual([])
    expect(result.setups).toEqual([])
    expect(result.output).toBe('')
  })

  test('bundles multiple .vue islands into a single islands.js', async () => {
    await writeFile(
      join(inputDir, 'Palette.vue'),
      `<script setup lang="ts">
defineProps<{ items: string[] }>()
</script>
<template><div class="palette"><button v-for="i in items" :key="i">{{ i }}</button></div></template>
`,
      'utf8',
    )
    await writeFile(
      join(inputDir, 'Canvas.vue'),
      `<template><div class="canvas">canvas</div></template>`,
      'utf8',
    )

    const result = await buildIslands({
      inputDir,
      outputDir,
      external: ['vue'],
      minify: false,
    })

    expect(result.islands).toEqual(['Canvas', 'Palette'])
    expect(result.output).toBe(join(outputDir, 'islands.js'))

    const bundle = await Bun.file(result.output).text()
    // The bundle contains the shared-app + Teleport mount code.
    expect(bundle).toContain('Teleport')
    expect(bundle).toContain('createApp')
    expect(bundle).toContain('[data-island]')
    // Both components are referenced in the lookup table.
    expect(bundle).toContain('Palette')
    expect(bundle).toContain('Canvas')
  })

  test('discovers setup.ts at the root and runs it on the shared app', async () => {
    await writeFile(
      join(inputDir, 'setup.ts'),
      `import type { App } from 'vue'
export default (app: App) => {
  app.config.globalProperties.$strav = 'hello'
}
`,
      'utf8',
    )
    await writeFile(join(inputDir, 'Widget.vue'), `<template><div>w</div></template>`, 'utf8')

    const result = await buildIslands({
      inputDir,
      outputDir,
      external: ['vue'],
      minify: false,
    })

    expect(result.setups).toEqual([join(inputDir, 'setup.ts')])
    const bundle = await Bun.file(result.output).text()
    // The setup default is invoked on the shared app — verify by
    // looking for the marker code that runs each setup.
    expect(bundle).toContain('$strav')
    expect(bundle).toContain('setup(app)')
  })

  test('multiple setup files apply in alphabetical order', async () => {
    await writeFile(
      join(inputDir, 'setup.ts'),
      `export default (app) => { app.first = true }`,
      'utf8',
    )
    await writeFile(
      join(inputDir, 'setup.router.ts'),
      `export default (app) => { app.second = true }`,
      'utf8',
    )
    await writeFile(join(inputDir, 'A.vue'), `<template><div /></template>`, 'utf8')

    const result = await buildIslands({
      inputDir,
      outputDir,
      external: ['vue'],
      minify: false,
    })

    expect(result.setups).toHaveLength(2)
    // Alphabetical: 'setup.router.ts' comes BEFORE 'setup.ts' in
    // standard byte-order. The order matters for plugins that depend
    // on each other; alphabetical is a stable, predictable rule.
    expect(result.setups[0]).toMatch(/setup\.router\.ts$/)
    expect(result.setups[1]).toMatch(/setup\.ts$/)
  })

  test('nested .vue files get dotted island names', async () => {
    await mkdir(join(inputDir, 'charts'), { recursive: true })
    await writeFile(
      join(inputDir, 'charts', 'Bar.vue'),
      `<template><div>bar</div></template>`,
      'utf8',
    )
    const result = await buildIslands({ inputDir, outputDir, external: ['vue'] })
    expect(result.islands).toEqual(['charts.Bar'])
  })

  test('honors a custom filename', async () => {
    await writeFile(join(inputDir, 'A.vue'), `<template><div /></template>`, 'utf8')
    const result = await buildIslands({
      inputDir,
      outputDir,
      external: ['vue'],
      filename: 'app-islands.v2.js',
    })
    expect(result.output).toBe(join(outputDir, 'app-islands.v2.js'))
  })
})
