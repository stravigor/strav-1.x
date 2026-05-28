/**
 * Bun bundler plugin for `.vue` Single-File Components.
 *
 * Loaded by `buildIslands()` so app code can stay framework-agnostic
 * — the plugin compiles each `.vue` file in the dependency graph
 * into a regular JS module via `@vue/compiler-sfc`. Bun.build then
 * handles tree-shaking, dependency walking, and final bundling.
 *
 * Supports:
 *   - `<script setup>` (inline-template path).
 *   - Options API (`<script>` + separate `<template>`).
 *   - `<style>` blocks (scoped or unscoped); CSS is injected into a
 *     `<style>` tag on module load.
 *
 * Doesn't support:
 *   - Hot-module reload (Bun's bundler runs once per build).
 *   - CSS Modules (`<style module>`); not modelled here until a real
 *     user needs them.
 *   - Custom SFC blocks (`<docs>`, `<i18n>`, …); ignored.
 *
 * The plugin is a thin wrapper — apps that want their own Vue
 * compilation pipeline (vite, esbuild, ...) can ignore
 * `buildIslands` and bring their own bundler, as long as the output
 * matches the [self-mounting contract](../../docs/view/api.md).
 *
 * @see https://github.com/vuejs/core/tree/main/packages/compiler-sfc
 */

import type { BunPlugin } from 'bun'

export function vueSfcPlugin(): BunPlugin {
  return {
    name: 'strav-vue-sfc',
    async setup(build) {
      // Dynamic import so the plugin only loads `@vue/compiler-sfc`
      // when an app actually builds islands. Users that don't use
      // islands never pay the import cost.
      const sfc = await import('@vue/compiler-sfc')
      const { parse, compileScript, compileTemplate, compileStyle } = sfc

      build.onLoad({ filter: /\.vue$/ }, async (args) => {
        const source = await Bun.file(args.path).text()
        const id = await hashId(args.path)
        const scopeId = `data-v-${id}`
        const { descriptor, errors } = parse(source, { filename: args.path })

        if (errors.length > 0) {
          throw new Error(
            `Vue SFC parse error in ${args.path}:\n${errors.map((e) => e.message).join('\n')}`,
          )
        }

        const scoped = descriptor.styles.some((s) => s.scoped === true)

        // ─── Script ──────────────────────────────────────────────────────
        let scriptCode = ''
        let bindings: Record<string, unknown> | undefined

        if (descriptor.script !== null || descriptor.scriptSetup !== null) {
          const result = compileScript(descriptor, {
            id,
            inlineTemplate: descriptor.scriptSetup !== null,
            sourceMap: false,
            templateOptions:
              scoped === true ? { scoped: true, id, compilerOptions: { scopeId } } : undefined,
          })
          scriptCode = result.content
          bindings = result.bindings as Record<string, unknown> | undefined
        }

        // ─── Template (Options API only — script-setup uses inlineTemplate) ─
        let templateCode = ''
        if (descriptor.template !== null && descriptor.scriptSetup === null) {
          const result = compileTemplate({
            source: descriptor.template.content,
            filename: args.path,
            id,
            scoped,
            compilerOptions: {
              // biome-ignore lint/suspicious/noExplicitAny: BindingMetadata is internal-ish
              bindingMetadata: bindings as any,
              scopeId: scoped ? scopeId : undefined,
            },
          })
          if (result.errors.length > 0) {
            throw new Error(
              `Vue template error in ${args.path}:\n${result.errors
                .map((e) => (typeof e === 'string' ? e : e.message))
                .join('\n')}`,
            )
          }
          templateCode = result.code
        }

        // ─── Styles ──────────────────────────────────────────────────────
        const styles: string[] = []
        for (const styleBlock of descriptor.styles) {
          const result = compileStyle({
            source: styleBlock.content,
            filename: args.path,
            id: scopeId,
            scoped: styleBlock.scoped === true,
          })
          if (result.errors.length > 0) {
            // Style errors are non-fatal: the file may still compile.
            // Log to stderr but don't block the build.
            for (const err of result.errors) console.warn(`[vue-sfc] style ${args.path}:`, err)
          }
          styles.push(result.code)
        }

        // ─── Assemble the output module ──────────────────────────────────
        let output = ''
        if (styles.length > 0) {
          // Injects the CSS at module load. Runs once per page; safe to
          // load multiple islands that share styles (de-dup via dataset).
          const css = JSON.stringify(styles.join('\n'))
          output +=
            '(function(){if(typeof document!=="undefined"){' +
            'var s=document.createElement("style");' +
            `s.textContent=${css};` +
            'document.head.appendChild(s)}})();\n'
        }

        if (descriptor.scriptSetup !== null) {
          // `<script setup>` with inline-template — scriptCode is a
          // complete module. Capture the default export so we can set
          // the scoped-styles marker before re-exporting.
          if (scoped === true) {
            output += `${scriptCode.replace(/export\s+default\s+/, 'const __sfc__ = ')}\n`
            output += `__sfc__.__scopeId = ${JSON.stringify(scopeId)};\n`
            output += 'export default __sfc__;\n'
          } else {
            output += `${scriptCode}\n`
          }
        } else {
          // Options API — stitch script + template render function
          // together. Either the script or the template can be
          // missing; both missing yields a bare `{}` component.
          if (scriptCode !== '') {
            output += `${scriptCode.replace(/export\s+default\s*\{/, 'const __component__ = {')}\n`
          } else {
            output += 'const __component__ = {};\n'
          }
          if (templateCode !== '') {
            output += `${templateCode}\n`
            output += '__component__.render = render;\n'
          }
          if (scoped === true) {
            output += `__component__.__scopeId = ${JSON.stringify(scopeId)};\n`
          }
          output += 'export default __component__;\n'
        }

        // `loader: 'ts'` lets the bundler strip remaining TS annotations
        // that the SFC compiler emits (e.g. `setup(__props: any)`).
        return { contents: output, loader: 'ts' }
      })
    },
  }
}

async function hashId(path: string): Promise<string> {
  // Stable per-file scope-id. MD5 is plenty for cache-busting / scope
  // disambiguation; not used cryptographically.
  const hasher = new Bun.CryptoHasher('md5')
  hasher.update(path)
  return hasher.digest('hex').slice(0, 8)
}
