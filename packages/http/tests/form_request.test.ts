import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Application,
  type Application as ApplicationType,
  AuthorizationError,
  ConfigProvider,
  inject,
  LoggerProvider,
  ServiceProvider,
} from '@strav/kernel'
import type { HttpContext } from '../src/context/types.ts'
import {
  clearRules,
  FormRequest,
  HttpKernel,
  HttpProvider,
  MiddlewareRegistry,
  Router,
  registerRule,
  rule,
} from '../src/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-form-req-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
  clearRules()
})
afterEach(() => {
  logDir.cleanup()
})

function seedProvider(seed: (router: Router, reg: MiddlewareRegistry) => void): ServiceProvider {
  return new (class extends ServiceProvider {
    override readonly name = 'test-routes'
    override readonly dependencies = ['http']
    override register(app: ApplicationType): void {
      seed(app.resolve(Router), app.resolve(MiddlewareRegistry))
    }
  })()
}

async function bootApp(
  seed?: (router: Router, reg: MiddlewareRegistry) => void,
): Promise<Application> {
  const app = new Application()
  const providers: ServiceProvider[] = [
    new ConfigProvider({
      logger: {
        default: 'file',
        level: 'error',
        channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
      },
    }),
    new LoggerProvider(),
    new HttpProvider(),
  ]
  if (seed) providers.push(seedProvider(seed))
  app.useProviders(providers)
  await app.start({ signalHandlers: false })
  return app
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle — authorize / transform / validate / cache
// ─────────────────────────────────────────────────────────────────────────────

describe('FormRequest — lifecycle', () => {
  class StoreUserRequest extends FormRequest<{ email: string; name: string }> {
    override authorize(_ctx: HttpContext): boolean {
      return true
    }
    override transform(input: Record<string, unknown>): Record<string, unknown> {
      return { ...input, email: String(input.email ?? '').toLowerCase() }
    }
    rules() {
      return {
        email: rule.email(),
        name: rule.string().min(1).max(255),
      }
    }
  }

  test('validates + transforms + exposes typed validated()', async () => {
    const app = await bootApp((router) => {
      router.post('/users', async (ctx) => {
        const req = await StoreUserRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/users', { email: 'Foo@EXAMPLE.com', name: 'Liva' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ email: 'foo@example.com', name: 'Liva' })
    } finally {
      await app.shutdown()
    }
  })

  test('authorize() returning false → AuthorizationError (403 in response)', async () => {
    class DeniedRequest extends FormRequest {
      override authorize(): boolean {
        return false
      }
      rules() {
        return {}
      }
    }
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        await DeniedRequest.from(ctx)
        return ctx.response.ok({ never: true })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(postJson('http://localhost/x', {}))
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('policy.denied')
    } finally {
      await app.shutdown()
    }
  })

  test('validation failure → 422 with errors map keyed by field', async () => {
    const app = await bootApp((router) => {
      router.post('/users', async (ctx) => {
        const req = await StoreUserRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/users', { email: 'not-an-email', name: '' }))
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        error: { code: string; errors: Record<string, Array<{ code: string; message: string }>> }
      }
      expect(body.error.code).toBe('validation.failed')
      expect(body.error.errors.email?.[0]?.code).toMatch(/^rule\./)
      expect(body.error.errors.name).toBeDefined()
    } finally {
      await app.shutdown()
    }
  })

  test('validated() before from() throws', () => {
    class TestRequest extends FormRequest {
      rules() {
        return {}
      }
    }
    const stubCtx = {} as HttpContext
    const req = new TestRequest(stubCtx)
    expect(() => req.validated()).toThrow(/before \.from\(ctx\)/)
  })

  test('thrown StravError inside authorize propagates unchanged', async () => {
    class CustomAuthError extends FormRequest {
      override authorize(): boolean {
        throw new AuthorizationError('Insufficient role.', { code: 'policy.users.update.denied' })
      }
      rules() {
        return {}
      }
    }
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        await CustomAuthError.from(ctx)
        return null
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(postJson('http://localhost/x', {}))
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('policy.users.update.denied')
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rule API — refines + registered rules
// ─────────────────────────────────────────────────────────────────────────────

describe('rule API', () => {
  test('inline .refine emits the supplied code', async () => {
    class PwdRequest extends FormRequest<{ pwd: string }> {
      rules() {
        return {
          pwd: rule
            .string()
            .min(8)
            .refine((s: string) => /[A-Z]/.test(s), {
              message: 'rule.password.no_upper',
              params: { code: 'rule.password.no_upper' },
            }),
        }
      }
    }
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        const req = await PwdRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/x', { pwd: 'allsmall1' }))
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        error: { errors: Record<string, Array<{ code: string }>> }
      }
      expect(body.error.errors.pwd?.[0]?.code).toBe('rule.password.no_upper')
    } finally {
      await app.shutdown()
    }
  })

  test('registered rule with args + DI receives the HttpContext', async () => {
    @inject()
    class FakeUserRepo {
      exists(_email: string): boolean {
        return true // pretend `taken@example.com` is taken
      }
    }
    registerRule('unique_email', (value, ctx, args) => {
      const repo = ctx.container.make(FakeUserRepo)
      const except = (args as { except?: string }).except
      const taken = repo.exists(String(value))
      if (taken && value !== except) {
        return { code: 'rule.unique', context: { column: 'email' } }
      }
      return true
    })

    class StoreUserRequest extends FormRequest<{ email: string }> {
      rules() {
        return {
          email: rule.email().pipe(rule.custom('unique_email', {})),
        }
      }
    }

    const app = await bootApp((router) => {
      router.post('/users', async (ctx) => {
        const req = await StoreUserRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/users', { email: 'taken@example.com' }))
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        error: { errors: Record<string, Array<{ code: string; context?: unknown }>> }
      }
      expect(body.error.errors.email?.[0]?.code).toBe('rule.unique')
      expect(body.error.errors.email?.[0]?.context).toEqual({ column: 'email' })
    } finally {
      await app.shutdown()
    }
  })

  test('referencing an unregistered custom rule fails with rule.<name>.unregistered', async () => {
    class TestRequest extends FormRequest<{ x: string }> {
      rules() {
        return { x: rule.string().pipe(rule.custom('nonexistent')) }
      }
    }
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        const req = await TestRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/x', { x: 'hello' }))
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        error: { errors: Record<string, Array<{ code: string }>> }
      }
      expect(body.error.errors.x?.[0]?.code).toBe('rule.nonexistent.unregistered')
    } finally {
      await app.shutdown()
    }
  })

  test('ValidationError carries field-level errors for nested object paths', async () => {
    class NestedRequest extends FormRequest<{ user: { email: string } }> {
      rules() {
        return {
          user: rule.object({ email: rule.email() }),
        }
      }
    }
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        const req = await NestedRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/x', { user: { email: 'not-email' } }))
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        error: { errors: Record<string, unknown> }
      }
      expect(body.error.errors['user.email']).toBeDefined()
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Router tuple-arity-3 sugar
// ─────────────────────────────────────────────────────────────────────────────

describe('Router — [Controller, method, FormRequest] tuple', () => {
  class StoreUserRequest extends FormRequest<{ email: string }> {
    rules() {
      return { email: rule.email() }
    }
  }

  @inject()
  class UserController {
    store(req: StoreUserRequest, ctx: HttpContext): Response {
      return ctx.response.ok({ via: 'tuple-3', data: req.validated() })
    }
  }

  test('happy path: req is pre-built, action receives (req, ctx)', async () => {
    const app = await bootApp((router) => {
      router.post('/users', [UserController, 'store', StoreUserRequest])
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/users', { email: 'a@b.com' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ via: 'tuple-3', data: { email: 'a@b.com' } })
    } finally {
      await app.shutdown()
    }
  })

  test('validation failure short-circuits before the controller method runs', async () => {
    let actionRan = false
    @inject()
    class Spy {
      store(_req: StoreUserRequest, ctx: HttpContext): Response {
        actionRan = true
        return ctx.response.ok({})
      }
    }
    const app = await bootApp((router) => {
      router.post('/users', [Spy, 'store', StoreUserRequest])
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(postJson('http://localhost/users', { email: 'bad' }))
      expect(res.status).toBe(422)
      expect(actionRan).toBe(false)
    } finally {
      await app.shutdown()
    }
  })

  test('2-arity tuple still works (no FormRequest)', async () => {
    @inject()
    class HealthController {
      check(ctx: HttpContext): Response {
        return ctx.response.ok({ ok: true })
      }
    }
    const app = await bootApp((router) => {
      router.get('/health', [HealthController, 'check'])
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/health'))
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Body handling
// ─────────────────────────────────────────────────────────────────────────────

describe('FormRequest — body handling', () => {
  class OptionalRequest extends FormRequest<{ name?: string }> {
    rules() {
      return { name: rule.optional(rule.string()) }
    }
  }

  test('empty body validates against optional fields', async () => {
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        const req = await OptionalRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(
        new Request('http://localhost/x', {
          method: 'POST',
          headers: { accept: 'application/json' },
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
    } finally {
      await app.shutdown()
    }
  })

  test('non-JSON content (text) treated as empty body for object schemas', async () => {
    class StrictRequest extends FormRequest<{ name: string }> {
      rules() {
        return { name: rule.string() }
      }
    }
    const app = await bootApp((router) => {
      router.post('/x', async (ctx) => {
        const req = await StrictRequest.from(ctx)
        return ctx.response.ok(req.validated())
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(
        new Request('http://localhost/x', {
          method: 'POST',
          headers: { 'content-type': 'text/plain', accept: 'application/json' },
          body: 'hello',
        }),
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as {
        error: { errors: Record<string, unknown> }
      }
      expect(body.error.errors.name).toBeDefined()
    } finally {
      await app.shutdown()
    }
  })
})
