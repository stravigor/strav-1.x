// Router subsystem — public exports.

export { Route } from './route.ts'
export { type ResolveOptions, resolveRoute } from './route_resolver.ts'
export { Router } from './router.ts'
export { type MatchResult, RouteTrie } from './trie.ts'
export type {
  ActionMethodNamesOf,
  ActionRef,
  ClosureHandler,
  CompiledRoute,
  FormRequestActionMethodNamesOf,
  FormRequestActionRef,
  HttpMethod,
  RouteGroupOptions,
  RouteHandler,
  SingleActionClass,
} from './types.ts'
