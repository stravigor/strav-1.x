import { describe, expect, test } from 'bun:test'
import { TemplateError, tokenize } from '../src/index.ts'

describe('tokenize — plain text', () => {
  test('all text yields one text token', () => {
    const t = tokenize('<h1>Hello world</h1>')
    expect(t).toHaveLength(1)
    expect(t[0]?.type).toBe('text')
    expect(t[0]?.value).toBe('<h1>Hello world</h1>')
    expect(t[0]?.line).toBe(1)
  })

  test('empty source produces no tokens', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('tokenize — interpolation', () => {
  test('{{ expr }} → escaped token with trimmed expression', () => {
    const t = tokenize('hi {{  user.name  }}!')
    expect(t).toHaveLength(3)
    expect(t[0]).toMatchObject({ type: 'text', value: 'hi ' })
    expect(t[1]).toMatchObject({ type: 'escaped', value: 'user.name' })
    expect(t[2]).toMatchObject({ type: 'text', value: '!' })
  })

  test('{!! expr !!} → raw token', () => {
    const t = tokenize('body: {!! markdown(post) !!}')
    expect(t[1]).toMatchObject({ type: 'raw', value: 'markdown(post)' })
  })

  test('{{ "}}" }} — strings inside the expression do not terminate early', () => {
    const t = tokenize('{{ "}}" }}')
    expect(t).toHaveLength(1)
    expect(t[0]?.type).toBe('escaped')
    expect(t[0]?.value).toBe('"}}"')
  })

  test('{{-- comment --}} is consumed', () => {
    const t = tokenize('a{{-- ignored --}}b')
    expect(t).toHaveLength(1)
    expect(t[0]?.value).toBe('ab')
  })

  test('unclosed {{ throws TemplateError', () => {
    expect(() => tokenize('{{ unclosed')).toThrow(TemplateError)
  })
})

describe('tokenize — directives', () => {
  test('@directive without args', () => {
    const t = tokenize('@csrf')
    expect(t).toEqual([{ type: 'directive', value: 'csrf', line: 1 }])
  })

  test('@directive(args) captures the arg source', () => {
    const t = tokenize('@if(user.isAdmin)')
    expect(t[0]).toMatchObject({ type: 'directive', value: 'if', args: 'user.isAdmin' })
  })

  test('nested parens + commas + objects inside args are balanced', () => {
    const t = tokenize("@route('users.show', { id: user.id })")
    expect(t[0]?.args).toBe("'users.show', { id: user.id }")
  })

  test('email @ is NOT a directive when not preceded by whitespace', () => {
    const t = tokenize('mailto:hello@example.com')
    expect(t).toHaveLength(1)
    expect(t[0]?.type).toBe('text')
  })

  test('line tracking — directive on line 3', () => {
    const t = tokenize('line1\nline2\n@if(cond)\nline4')
    const dir = t.find((tok) => tok.type === 'directive')
    expect(dir?.line).toBe(3)
  })

  test('unclosed @directive(... throws', () => {
    expect(() => tokenize('@if(user.foo')).toThrow(/Unclosed/)
  })
})

describe('tokenize — @raw block', () => {
  test('@raw ... @endraw is a single text token (verbatim)', () => {
    const src = '@raw{{ not interpolated }}@if(x){{ y }}@endraw'
    const t = tokenize(src)
    expect(t).toHaveLength(1)
    expect(t[0]?.type).toBe('text')
    expect(t[0]?.value).toBe('{{ not interpolated }}@if(x){{ y }}')
  })

  test('unclosed @raw throws', () => {
    expect(() => tokenize('@raw forever')).toThrow(/Unclosed `@raw`/)
  })

  test('@endraw without matching @raw throws', () => {
    expect(() => tokenize('@endraw')).toThrow(/without matching/)
  })
})
