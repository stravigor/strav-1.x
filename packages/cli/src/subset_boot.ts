/**
 * Subset boot — given the default provider list and a list of provider names
 * requested by a command's `static providers`, return the filtered list with
 * transitive `dependencies` auto-included.
 *
 * Spec:
 *   - `undefined` → return the full default list (no filtering).
 *   - `[]`        → return an empty array.
 *   - `[names...]` → look each name up in the default list; pull in every
 *     transitive `dependencies = [...]` entry; topo-order preserved by the
 *     application's own sort.
 *   - Unknown name → `ConfigError` with a clear message.
 */

import { ConfigError, type ServiceProvider } from '@strav/kernel'

export function selectProviders(
  defaults: readonly ServiceProvider[],
  requested: readonly string[] | undefined,
  commandName: string,
): ServiceProvider[] {
  if (requested === undefined) return [...defaults]
  if (requested.length === 0) return []

  const byName = new Map<string, ServiceProvider>()
  for (const p of defaults) byName.set(p.name, p)

  const selected = new Map<string, ServiceProvider>()

  const visit = (name: string, trail: readonly string[]): void => {
    if (selected.has(name)) return
    if (trail.includes(name)) {
      throw new ConfigError(
        `ConsoleProvider: circular provider dependency while resolving '${commandName}': ${[...trail, name].join(' → ')}`,
      )
    }
    const provider = byName.get(name)
    if (!provider) {
      throw new ConfigError(
        `Command '${commandName}' declared provider '${name}' which is not in the default providers list`,
      )
    }
    for (const dep of provider.dependencies) {
      visit(dep, [...trail, name])
    }
    selected.set(name, provider)
  }

  for (const name of requested) visit(name, [])
  return [...selected.values()]
}
