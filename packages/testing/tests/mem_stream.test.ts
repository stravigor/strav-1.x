import { describe, expect, test } from 'bun:test'
import { MemStream } from '../src/mem_stream.ts'

describe('MemStream', () => {
  test('captures written chunks in order', () => {
    const s = new MemStream()
    s.write('hello ')
    s.write('world')
    expect(s.text()).toBe('hello world')
    expect(s.chunks).toEqual(['hello ', 'world'])
  })

  test('write returns true so backpressure-checking callers proceed', () => {
    const s = new MemStream()
    expect(s.write('x')).toBe(true)
  })

  test('clear() drops buffered chunks', () => {
    const s = new MemStream()
    s.write('a')
    s.write('b')
    s.clear()
    expect(s.text()).toBe('')
    expect(s.chunks).toEqual([])
  })

  test('asWritable returns the same instance, typed as NodeJS.WritableStream', () => {
    const s = new MemStream()
    const w = s.asWritable()
    w.write('hi')
    expect(s.text()).toBe('hi')
  })
})
