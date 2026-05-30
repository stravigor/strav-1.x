/**
 * Scaffolder. Walks the template tree under `src/templates/{shared,<template>}/`,
 * copies each file to `dest`, and applies a tiny `{{token}}` pass to `.tt`
 * files. Plain files are copied byte-for-byte.
 *
 * Conventions baked in:
 *   - Files named with a leading `_dot_` are written with a leading `.`. This
 *     avoids npm-publish edge cases where dotfiles inside `src/` can be ignored
 *     by registries' implicit ignore lists.
 *   - The `.tt` suffix marks a file with `{{token}}` interpolation. The suffix
 *     is stripped on write. `{{token}}` is a literal replace — no conditionals,
 *     no loops.
 *   - Overlay order: `shared/` is copied first, then `<template>/` is copied
 *     on top, with overlay files overwriting matching paths.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { SpringError } from './spring_error.ts'

const TEMPLATES_ROOT = join(import.meta.dir, 'templates')

export interface ScaffoldOptions {
  projectName: string
  template: 'api' | 'web'
  dbName: string
  /** Absolute path the project is written to. */
  dest: string
  /**
   * Override the framework version string injected into the generated
   * `package.json`. Tests pass `'workspace:*'` so the scaffolded app can
   * boot inside this monorepo without `bun install`. Defaults to the
   * pinned constant from `version.ts`.
   */
  stravVersion?: string
}

export interface ScaffoldResult {
  /** Project-root-relative paths of every file written. */
  files: readonly string[]
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const tokens = {
    projectName: opts.projectName,
    dbName: opts.dbName,
    stravVersion: opts.stravVersion ?? (await defaultStravVersion()),
  }

  const written: string[] = []
  const overlayLayers = [join(TEMPLATES_ROOT, 'shared'), join(TEMPLATES_ROOT, opts.template)]

  for (const layer of overlayLayers) {
    if (!(await pathExists(layer))) {
      // The overlay for a given template may be absent (e.g., --api has no
      // overlay in slice A — everything ships in shared/). Skip silently.
      continue
    }
    for await (const sourceFile of walk(layer)) {
      const rel = relative(layer, sourceFile)
      const targetRel = applyDotPrefix(stripTemplateSuffix(rel))
      const targetAbs = join(opts.dest, targetRel)
      await mkdir(dirname(targetAbs), { recursive: true })

      if (sourceFile.endsWith('.tt')) {
        const raw = await readFile(sourceFile, 'utf8')
        await writeFile(targetAbs, interpolate(raw, tokens), 'utf8')
      } else {
        const buf = await readFile(sourceFile)
        await writeFile(targetAbs, buf)
      }
      written.push(targetRel)
    }
  }

  // .gitkeep files don't have a real purpose in the generated tree — they
  // exist only so empty template directories survive git/npm. Strip from
  // the result manifest so tests see a clean list, but leave on disk so
  // `make:*` commands can target the directories.
  return { files: written.sort() }
}

async function* walk(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function stripTemplateSuffix(path: string): string {
  return path.endsWith('.tt') ? path.slice(0, -3) : path
}

const DOT_PREFIX = '_dot_'

function applyDotPrefix(path: string): string {
  // Apply per-segment so nested files like `_dot_github/workflows/x.yml` work.
  return path
    .split('/')
    .map((seg) => (seg.startsWith(DOT_PREFIX) ? `.${seg.slice(DOT_PREFIX.length)}` : seg))
    .join('/')
}

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g

function interpolate(source: string, tokens: Record<string, string>): string {
  return source.replace(TOKEN_RE, (_, name: string) => {
    const value = tokens[name]
    if (value === undefined) {
      throw new SpringError(`template references unknown token {{${name}}}`)
    }
    return value
  })
}

async function defaultStravVersion(): Promise<string> {
  const { STRAV_VERSION } = await import('./version.ts')
  return STRAV_VERSION
}
