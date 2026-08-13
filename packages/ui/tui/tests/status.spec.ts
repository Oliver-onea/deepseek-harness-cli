import { describe, expect, it } from 'vitest'
import { formatContext, formatElapsed, formatPlan, formatTokens, renderStatus } from '../src/status.ts'
import type { StatusInput } from '../src/status.ts'
import { createPalette } from '../src/theme.ts'

const plain = createPalette(false)

const idle: StatusInput = {
  running: false,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  elapsedMs: 0,
  tokens: 0,
  contextWindow: undefined,
  queued: 0,
  todos: [],
}

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [12_400, '12s'],
    [59_999, '59s'],
    [60_000, '1m00s'],
    [184_000, '3m04s'],
  ])('renders %ims as %s', (elapsed, expected) => {
    expect(formatElapsed(elapsed)).toBe(expected)
  })
})

describe('formatTokens', () => {
  it.each([[0, '0'], [999, '999'], [1000, '1.0k'], [12_345, '12.3k']])(
    'renders %i as %s', (tokens, expected) => {
      expect(formatTokens(tokens)).toBe(expected)
    })
})

describe('formatContext', () => {
  it('reports the raw count when the route advertises no capacity', () => {
    expect(formatContext(1500, undefined)).toBe('1.5k tokens')
  })

  it('reports occupancy against an advertised capacity', () => {
    expect(formatContext(16_000, 64_000)).toBe('16.0k/64.0k (25%)')
  })

  it('never reports more than a full context', () => {
    expect(formatContext(70_000, 64_000)).toBe('70.0k/64.0k (100%)')
  })
})

describe('formatPlan', () => {
  it('says nothing when nothing is planned', () => {
    expect(formatPlan([])).toBeUndefined()
  })

  it('counts completed work', () => {
    expect(formatPlan([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ])).toBe('plan 1/2')
  })

  it('names the task in progress', () => {
    expect(formatPlan([
      { content: 'a', status: 'completed' },
      { content: 'wire the parser', status: 'in_progress' },
    ])).toBe('plan 1/2 — wire the parser')
  })
})

describe('renderStatus', () => {
  it('reads as ready with the route and the exit hint while idle', () => {
    expect(renderStatus(idle, plain))
      .toBe('ready · deepseek-official/deepseek-v4-flash · 0 tokens · /help  ctrl+c exit')
  })

  it('swaps in elapsed time and the interrupt hint while a turn runs', () => {
    expect(renderStatus({ ...idle, running: true, elapsedMs: 5000 }, plain))
      .toBe('working 5s · deepseek-official/deepseek-v4-flash · 0 tokens · esc interrupt')
  })

  it('reports queued work and the plan when there is any', () => {
    const status = renderStatus({
      ...idle,
      queued: 2,
      todos: [{ content: 'ship it', status: 'in_progress' }],
    }, plain)
    expect(status).toContain('plan 0/1 — ship it')
    expect(status).toContain('2 queued')
  })

  it('styles the same fields when the palette has color', () => {
    expect(renderStatus(idle, createPalette(true))).toContain('\x1b[32mready\x1b[39m')
  })
})
