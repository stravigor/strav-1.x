/**
 * IoC container. The foundation of the Strav framework.
 *
 * - `register` / `singleton` / `scoped` bind factories and classes.
 * - `resolve` looks up a binding by class or string name (strict).
 * - `make` auto-constructs a class via `@inject()` metadata, falling back to
 *   `resolve` for any param that has a binding.
 * - `bind(Interface, Concrete)` is sugar for alias-binding.
 * - `tag` + `tagged` collect classes by group.
 * - `when(Consumer).needs(Dep).give(Impl)` overrides a dep for one consumer.
 * - `createScope` returns a child container with its own instance cache.
 *
 * @see docs/kernel/api.md for the full reference.
 */

import { getParamTypes, isInjectable } from './inject.ts'
import type { Binding, Constructor, ContextualKey, Factory, Key } from './types.ts'

export class Container {
  /** Bindings registered on this container. */
  private bindings = new Map<Key, Binding>()

  /**
   * Singleton instances cached at this container.
   * Singletons cache at the container where they were bound; scoped bindings
   * cache at the resolving container instead (see `resolve`).
   */
  private instances = new Map<Key, unknown>()

  /** Tag → set of tagged keys. */
  private tags = new Map<string, Set<Key>>()

  /**
   * Contextual overrides: when constructing `consumer`, substitute `dep` with
   * `impl`. `impl` may be a key (looked up) or a factory.
   */
  private contextual = new Map<ContextualKey, Map<Key, Constructor | Factory<unknown>>>()

  /** Parent container, set by `createScope`. */
  protected parent: Container | undefined

  // ───────────────────────────────────────────────────────────────────────────
  // Bindings
  // ───────────────────────────────────────────────────────────────────────────

  /** Bind a factory (new instance per resolve). */
  register<T>(ctor: Constructor<T>): this
  register<T>(ctor: Constructor<T>, factory: Factory<T>): this
  register<T>(name: string, factoryOrClass: Factory<T> | Constructor<T>): this
  register<T>(keyOrCtor: string | Constructor<T>, factory?: Factory<T> | Constructor<T>): this {
    return this.bindEntry(keyOrCtor, factory, 'factory')
  }

  /** Bind a singleton (one instance shared by all consumers of this container). */
  singleton<T>(ctor: Constructor<T>): this
  singleton<T>(ctor: Constructor<T>, factory: Factory<T>): this
  singleton<T>(name: string, factoryOrClass: Factory<T> | Constructor<T>): this
  singleton<T>(keyOrCtor: string | Constructor<T>, factory?: Factory<T> | Constructor<T>): this {
    return this.bindEntry(keyOrCtor, factory, 'singleton')
  }

  /**
   * Bind a scoped singleton — one instance per scope (the child container
   * returned by `createScope()`). Each scope creates its own instance on
   * first resolve and caches it locally.
   */
  scoped<T>(ctor: Constructor<T>): this
  scoped<T>(ctor: Constructor<T>, factory: Factory<T>): this
  scoped<T>(name: string, factoryOrClass: Factory<T> | Constructor<T>): this
  scoped<T>(keyOrCtor: string | Constructor<T>, factory?: Factory<T> | Constructor<T>): this {
    return this.bindEntry(keyOrCtor, factory, 'scoped')
  }

  /** Bind an interface (string or abstract class) to a concrete class. */
  bind<T>(interfaceKey: string | Constructor<T>, concrete: Constructor<T>): this {
    const factory: Factory<T> = (c) => c.make(concrete)
    if (typeof interfaceKey === 'string') return this.singleton(interfaceKey, factory)
    return this.singleton(interfaceKey, factory)
  }

  /** Tag a set of classes under a name; retrieve with `tagged(name)`. */
  tag(classes: Constructor[], name: string): this {
    let set = this.tags.get(name)
    if (!set) {
      set = new Set()
      this.tags.set(name, set)
    }
    for (const cls of classes) set.add(cls)
    return this
  }

  /** Builder: `app.when(Consumer).needs(Dep).give(Impl)`. */
  when<T>(consumer: Constructor<T>): WhenBuilder<T> {
    return new WhenBuilder<T>(this, consumer)
  }

  /** @internal Called by WhenBuilder. */
  registerContextual(
    consumer: ContextualKey,
    dep: Key,
    impl: Constructor | Factory<unknown>,
  ): void {
    let inner = this.contextual.get(consumer)
    if (!inner) {
      inner = new Map()
      this.contextual.set(consumer, inner)
    }
    inner.set(dep, impl)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Resolution
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Strict lookup by class or string name. Throws if not bound.
   *
   * Use `make(Class)` instead when the class should auto-construct if unbound.
   */
  resolve<T>(ctor: Constructor<T>): T
  resolve<T>(name: string): T
  resolve<T>(key: Key<T>): T {
    return this.resolveInternal(key)
  }

  /**
   * Look up a binding or auto-construct via `@inject()` metadata.
   *
   * If `Class` is bound, behaves like `resolve(Class)`.
   * If not, reads constructor param types and recursively resolves each one,
   * then `new Class(...deps)`.
   */
  make<T>(Class: Constructor<T>): T {
    return this.makeInternal(Class)
  }

  /** Return instances of every class tagged with `name`. */
  tagged<T>(name: string): T[] {
    const out: T[] = []
    // Walk up the parent chain — tags may live anywhere.
    for (const container of this.chain()) {
      const set = container.tags.get(name)
      if (!set) continue
      for (const key of set) {
        out.push(
          typeof key === 'function'
            ? (this.make(key as Constructor<unknown>) as T)
            : (this.resolve(key as string) as T),
        )
      }
    }
    return out
  }

  /** Is the given class or name bound anywhere in the chain? */
  has(key: Key): boolean {
    for (const container of this.chain()) {
      if (container.bindings.has(key)) return true
    }
    return false
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scopes
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a child container. Bindings on the parent are inherited; the child
   * has its own instance cache. Scoped bindings are instantiated per-scope.
   */
  createScope(): Container {
    const scope = new Container()
    scope.parent = this
    return scope
  }

  /**
   * Discard this scope's cached singleton/scoped instances. The container is
   * still usable (factories remain), but cached state is gone. Call when a
   * request/job/command finishes.
   */
  dispose(): void {
    this.instances.clear()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /** Walk this container and every parent. */
  protected *chain(): Generator<Container> {
    let cur: Container | undefined = this
    while (cur) {
      yield cur
      cur = cur.parent
    }
  }

  /** Find the container that owns a binding for `key`, plus the binding itself. */
  private findBinding(key: Key): { owner: Container; binding: Binding } | undefined {
    for (const container of this.chain()) {
      const binding = container.bindings.get(key)
      if (binding) return { owner: container, binding }
    }
    return undefined
  }

  private bindEntry<T>(
    keyOrCtor: string | Constructor<T>,
    factory: Factory<T> | Constructor<T> | undefined,
    kind: Binding['kind'],
  ): this {
    const key: Key = keyOrCtor
    const f: Factory<T> = this.toFactory(keyOrCtor, factory)
    this.bindings.set(key, { factory: f as Factory<unknown>, kind })
    // Re-bind invalidates any cached instance at this container.
    this.instances.delete(key)
    return this
  }

  /**
   * Coerce the factory argument: class → @inject() factory; factory → as-is.
   *
   * Critical detail: when the resolved factory is "construct this class via
   * @inject()", we must NOT call `c.make(Class)` — that would re-enter the
   * binding lookup and recurse forever. Instead, we call `constructFromInject`
   * directly to build a fresh instance.
   */
  private toFactory<T>(
    keyOrCtor: string | Constructor<T>,
    factory: Factory<T> | Constructor<T> | undefined,
  ): Factory<T> {
    if (factory === undefined) {
      // register(Class) — use the class as both key and factory
      if (typeof keyOrCtor === 'function') {
        const Cls = keyOrCtor as Constructor<T>
        return (c) => c.constructFromInject(Cls)
      }
      throw new Error(
        `Container: register('${keyOrCtor}') needs a factory or class as the second argument.`,
      )
    }
    if (typeof factory === 'function' && this.looksLikeClass(factory)) {
      const ClassRef = factory as Constructor<T>
      return (c) => c.constructFromInject(ClassRef)
    }
    return factory as Factory<T>
  }

  /**
   * Heuristic: is this function a class constructor?
   * Conservative — we only treat it as a class if it has a non-empty prototype
   * with members beyond `constructor`, or if marked `@inject()`.
   * For ambiguous cases (a class without `@inject()` and no methods), the user
   * can wrap it in an explicit factory.
   */
  // biome-ignore lint/suspicious/noExplicitAny: heuristic operates on bare functions
  private looksLikeClass(fn: any): boolean {
    if (isInjectable(fn)) return true
    // ES2015+ classes can be detected by their string representation.
    const src = Function.prototype.toString.call(fn)
    return src.startsWith('class ') || src.startsWith('class{')
  }

  private resolveInternal<T>(key: Key<T>): T {
    const entry = this.findBinding(key)
    if (!entry) {
      const label = typeof key === 'string' ? `"${key}"` : (key as Constructor).name
      throw new Error(`Container: service ${label} is not registered.`)
    }

    const { owner, binding } = entry

    // factory kind: new instance every time
    if (binding.kind === 'factory') {
      return binding.factory(this) as T
    }

    // singleton: cache at the OWNING container (shared across all scopes)
    if (binding.kind === 'singleton') {
      if (!owner.instances.has(key)) {
        owner.instances.set(key, binding.factory(this))
      }
      return owner.instances.get(key) as T
    }

    // scoped: cache at the RESOLVING container (this), per scope
    if (!this.instances.has(key)) {
      this.instances.set(key, binding.factory(this))
    }
    return this.instances.get(key) as T
  }

  private makeInternal<T>(Class: Constructor<T>): T {
    // If bound, defer to the binding's lifecycle (singleton cache, scoped, etc.).
    if (this.has(Class)) return this.resolveInternal(Class)
    return this.constructFromInject(Class)
  }

  /**
   * Build a fresh instance via `@inject()` metadata WITHOUT consulting bindings.
   *
   * Used by:
   *   - `make()`'s fallback path (unbound class).
   *   - Factories produced by `register(Class)` / `singleton(Class)` etc., so
   *     the binding's factory doesn't recursively re-enter `make`.
   *
   * Dep resolution inside this method DOES go through `make()`, so each dep
   * honors its own binding (singleton vs scoped vs factory) as expected.
   */
  constructFromInject<T>(Class: Constructor<T>): T {
    const params = getParamTypes(Class)
    // `Class.length` reports the constructor's declared param count. If the user
    // wrote constructor params but didn't apply @inject(), TypeScript emits no
    // metadata, so `params.length === 0` while `Class.length > 0`. Catch that.
    if (params.length === 0) {
      if (Class.length > 0) {
        throw new Error(
          `Container: cannot make ${Class.name} — its constructor declares ` +
            `${Class.length} param(s) but the class is not marked with @inject(), ` +
            `so no metadata was emitted. Add @inject() above the class, or register ` +
            `a factory: app.singleton(${Class.name}, (c) => new ${Class.name}(...))`,
        )
      }
      return new Class()
    }

    if (!isInjectable(Class)) {
      throw new Error(
        `Container: cannot make ${Class.name} — it has ${params.length} constructor ` +
          `param(s) but is not marked with @inject(). Add @inject() above the class, ` +
          `or register a factory: app.singleton(${Class.name}, (c) => new ${Class.name}(...))`,
      )
    }

    const ctxOverrides = this.contextualFor(Class)
    const deps = params.map((p, i) => this.resolveDep(Class, p, i, ctxOverrides))
    return new Class(...deps)
  }

  /** Look up contextual overrides for this consumer across the chain. */
  private contextualFor(
    consumer: Constructor,
  ): Map<Key, Constructor | Factory<unknown>> | undefined {
    for (const container of this.chain()) {
      const inner = container.contextual.get(consumer)
      if (inner) return inner
    }
    return undefined
  }

  private resolveDep(
    consumer: Constructor,
    paramType: Constructor | undefined,
    paramIndex: number,
    overrides: Map<Key, Constructor | Factory<unknown>> | undefined,
  ): unknown {
    if (paramType === undefined) {
      throw new Error(
        `Container: cannot resolve param #${paramIndex} of ${consumer.name} — ` +
          `the type is undefined (likely a circular class reference or a primitive type).`,
      )
    }

    // Contextual override wins.
    const override = overrides?.get(paramType)
    if (override !== undefined) {
      return typeof override === 'function' && this.looksLikeClass(override)
        ? this.make(override as Constructor)
        : (override as Factory<unknown>)(this)
    }

    // Auto-resolve via make (which falls through to resolve for bound classes).
    return this.make(paramType)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// when().needs().give() builder
// ─────────────────────────────────────────────────────────────────────────────

export class WhenBuilder<TConsumer> {
  constructor(
    private container: Container,
    private consumer: Constructor<TConsumer>,
  ) {}

  needs<TDep>(dep: Constructor<TDep>): NeedsBuilder<TConsumer, TDep>
  needs<TDep>(dep: string): NeedsBuilder<TConsumer, TDep>
  needs<TDep>(dep: Key<TDep>): NeedsBuilder<TConsumer, TDep> {
    return new NeedsBuilder<TConsumer, TDep>(this.container, this.consumer, dep)
  }
}

export class NeedsBuilder<TConsumer, TDep> {
  constructor(
    private container: Container,
    private consumer: Constructor<TConsumer>,
    private dep: Key<TDep>,
  ) {}

  give(impl: Constructor<TDep>): Container
  give(factory: Factory<TDep>): Container
  give(impl: Constructor<TDep> | Factory<TDep>): Container {
    this.container.registerContextual(
      this.consumer,
      this.dep,
      impl as Constructor | Factory<unknown>,
    )
    return this.container
  }
}
