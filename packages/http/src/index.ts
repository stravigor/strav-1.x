// Public API of @strav/http.
// Consumer apps import from this barrel; sub-paths exist for other @strav/*
// packages that need a specific subsystem (router, context, middleware).

export {
  BUILTIN_NAMES,
  type CorsOptions,
  corsMiddleware,
  RequestLog,
  type SecurityHeadersOptions,
  securityHeadersMiddleware,
} from './built_in/index.ts'
export { All, Console, HttpConsoleProvider, RouteList, Serve } from './console/index.ts'
export {
  type AppContextState,
  type BuildServerInfoOptions,
  buildServerInfo,
  type CookieOptions,
  HttpContext,
  type HttpContextApi,
  type HttpContextConfigSlice,
  type HttpContextExtensions,
  HttpRequest,
  type HttpRequestApi,
  HttpResponse,
  type HttpResponseApi,
  type ServerInfo,
} from './context/index.ts'
export {
  ExceptionHandler,
  type ExceptionHandlerOptions,
} from './exception_handler.ts'
export {
  type ContextEnricher,
  type HandleOptions,
  HttpKernel,
  type HttpKernelOptions,
  type ServeHandle,
  type ServeOptions,
} from './http_kernel.ts'
export { type HttpConfigShape, HttpProvider } from './http_provider.ts'
export {
  type ComposedChain,
  composeMiddleware,
  type FinalHandler,
  type MiddlewareClass,
  type MiddlewareDef,
  type MiddlewareEntry,
  type MiddlewareFactory,
  type MiddlewareFn,
  MiddlewareRegistry,
  type NextFn,
} from './middleware/index.ts'
export {
  clearRules,
  FormRequest,
  hasRule,
  type RuleContext,
  type RuleFn,
  type RuleResult,
  type RulesShape,
  registerRule,
  replaceRule,
  rule,
  z,
} from './requests/index.ts'
export {
  type ActionMethodNamesOf,
  type ActionRef,
  type ClosureHandler,
  type CompiledRoute,
  type FormRequestActionMethodNamesOf,
  type FormRequestActionRef,
  type HttpMethod,
  type MatchResult,
  type ResolveOptions,
  Route,
  type RouteGroupOptions,
  type RouteHandler,
  Router,
  RouteTrie,
  resolveRoute,
  type SingleActionClass,
} from './router/index.ts'
