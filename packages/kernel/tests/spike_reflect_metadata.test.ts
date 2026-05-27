/**
 * M1 spike: verify reflect-metadata + Bun decorators round-trip constructor param types.
 *
 * Findings — see spec/architecture.md § "Circular dependency limitation".
 *
 * If this passes:
 *   - We can read `design:paramtypes` reliably.
 *   - Subclass param types are read from the most-derived constructor.
 *   - Empty constructors return undefined (coerce to []).
 *
 * If this fails, the @inject() API needs a redesign.
 */

import 'reflect-metadata'
import { describe, expect, test } from 'bun:test'

const INJECTABLE = Symbol.for('@strav/kernel/INJECTABLE')

// The decorator the container will use to mark a class.
// Mirrors what we'll ship in `core/inject.ts`.
function inject(): ClassDecorator {
  return (target: object) => {
    Object.defineProperty(target, INJECTABLE, { value: true })
  }
}

// Cast helper for reading the symbol marker without TS index-signature noise.
function injectableMarker(cls: object): unknown {
  return (cls as unknown as Record<symbol, unknown>)[INJECTABLE]
}

describe('reflect-metadata + decorators (M1 spike)', () => {
  test('reads param types from a simple class', () => {
    class Logger {}
    class Database {}

    @inject()
    class UserService {
      constructor(
        public db: Database,
        public log: Logger,
      ) {}
    }

    // Reference the class so it isn't tree-shaken
    void new UserService(new Database(), new Logger())

    const params = Reflect.getMetadata('design:paramtypes', UserService) as unknown[]
    expect(params).toBeDefined()
    expect(params).toHaveLength(2)
    expect(params[0]).toBe(Database)
    expect(params[1]).toBe(Logger)
  })

  test('@inject marker is detectable on the class', () => {
    @inject()
    class Foo {}

    class Bar {}

    expect(injectableMarker(Foo)).toBe(true)
    expect(injectableMarker(Bar)).toBeUndefined()
  })

  test('class without constructor params returns empty array (or undefined → coerce to [])', () => {
    @inject()
    class Empty {}

    const params = (Reflect.getMetadata('design:paramtypes', Empty) ?? []) as unknown[]
    expect(params).toEqual([])
  })

  test('subclass param types reflect the SUBCLASS constructor', () => {
    class Base {}

    @inject()
    class Sub extends Base {
      constructor(public dep: string) {
        super()
      }
    }

    void new Sub('x')

    const params = Reflect.getMetadata('design:paramtypes', Sub) as unknown[]
    expect(params).toBeDefined()
    expect(params).toHaveLength(1)
    expect(params[0]).toBe(String) // primitive types come through as their constructors
  })

  test('LIMITATION: circular class refs in constructor params throw at module-load', () => {
    // Documented finding: TypeScript emits the type as a runtime variable reference.
    // If class A references class B as a constructor-param type and B isn't yet declared,
    // the @inject() decorator call hits the temporal dead zone for B.
    //
    // The framework does NOT ship a workaround for this. Users must restructure —
    // extract a common abstraction, or move shared state into a dedicated service.
    expect(() => {
      const evalThrowingModule = () => {
        @inject()
        class A {
          constructor(public b?: B) {}
        }
        @inject()
        class B {
          constructor(public a?: A) {}
        }
        void new A()
        void new B()
      }
      evalThrowingModule()
    }).toThrow(/Cannot access ['"]B['"] before initialization/)
  })

  test('decorator metadata is per-class; subclasses with own ctor override', () => {
    @inject()
    class Parent {
      constructor(public name: string) {}
    }

    class ChildNoCtor extends Parent {}

    @inject()
    class ChildWithCtor extends Parent {
      constructor(
        name: string,
        public id: number,
      ) {
        super(name)
      }
    }

    void new Parent('p')
    void new ChildNoCtor('c')
    void new ChildWithCtor('cw', 1)

    const parentParams = Reflect.getMetadata('design:paramtypes', Parent) as unknown[]
    expect(parentParams).toHaveLength(1)
    expect(parentParams[0]).toBe(String)

    // ChildNoCtor inherits the constructor; Reflect walks the prototype chain.
    const childNoCtorParams = Reflect.getMetadata('design:paramtypes', ChildNoCtor) as unknown[]
    expect(childNoCtorParams).toBeDefined()
    expect(childNoCtorParams).toHaveLength(1)

    const childParams = Reflect.getMetadata('design:paramtypes', ChildWithCtor) as unknown[]
    expect(childParams).toHaveLength(2)
    expect(childParams[0]).toBe(String)
    expect(childParams[1]).toBe(Number)
  })
})
