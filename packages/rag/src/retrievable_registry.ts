/**
 * `RetrievableRegistry` — bag of named pointers to retrievable
 * repositories so the `rag:reindex` console command can resolve
 * them at runtime.
 *
 * The framework can't statically discover which repositories use
 * the `retrievable()` mixin — apps register them at boot:
 *
 *   const registry = app.resolve(RetrievableRegistry)
 *   registry.register('articles', ArticleRepository)
 *
 * Then:
 *
 *   bun strav rag:reindex articles
 *   bun strav rag:reindex --all
 *
 * resolves the repository through the container and calls
 * `reindexAll(batchSize)`. The repo class must implement
 * `reindexAll(batchSize?: number): Promise<number>` — the
 * `retrievable()` mixin provides exactly that shape.
 */

import { inject } from '@strav/kernel'
import { RagError } from './rag_error.ts'

export interface RetrievableTarget {
  reindexAll(batchSize?: number): Promise<number>
}

// biome-ignore lint/suspicious/noExplicitAny: container-resolved constructor; the user-side class narrows.
type RetrievableConstructor = new (...args: any[]) => RetrievableTarget

@inject()
export class RetrievableRegistry {
  private readonly targets = new Map<string, RetrievableConstructor>()

  /**
   * Register a repository class under `name`. The class will be
   * resolved from the container on `rag:reindex <name>`.
   */
  register(name: string, ctor: RetrievableConstructor): void {
    this.targets.set(name, ctor)
  }

  /** List every registered name — used by `rag:reindex --all`. */
  names(): readonly string[] {
    return [...this.targets.keys()]
  }

  /** Resolve the constructor for one name. Throws when unregistered. */
  resolve(name: string): RetrievableConstructor {
    const ctor = this.targets.get(name)
    if (ctor === undefined) {
      throw new RagError(`RetrievableRegistry: no retrievable registered under "${name}".`, {
        context: { requested: name, available: this.names() },
      })
    }
    return ctor
  }
}
