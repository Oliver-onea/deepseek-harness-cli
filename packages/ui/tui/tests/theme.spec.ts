import { describe, expect, it } from 'vitest'
import { createPalette, detectColorDepth } from '../src/theme.ts'
import { createTerminalPalette, resolveColorDepth } from '../src/index.ts'

describe('detectColorDepth', () => {
  it('reads a truecolor advertisement from COLORTERM', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor')
    expect(detectColorDepth({ COLORTERM: '24bit' })).toBe('truecolor')
    expect(detectColorDepth({ COLORTERM: 'TrueColor' })).toBe('truecolor')
  })

  it('prefers the COLORTERM advertisement over TERM', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor', TERM: 'xterm' })).toBe('truecolor')
  })

  it('reads a 256-color terminal from TERM', () => {
    expect(detectColorDepth({ TERM: 'xterm-256color' })).toBe('256')
    expect(detectColorDepth({ TERM: 'tmux-256color' })).toBe('256')
  })

  it('falls back to the 16-color set when nothing states more', () => {
    expect(detectColorDepth({ TERM: 'xterm' })).toBe('16')
    expect(detectColorDepth({})).toBe('16')
  })
})

describe('createPalette', () => {
  it('returns identity styles when color is off', () => {
    const palette = createPalette(false)
    expect(palette.user('text')).toBe('text')
    expect(palette.selected('row')).toBe('row')
  })

  it('draws the truecolor tier with 24-bit sequences', () => {
    const palette = createPalette(true, 'truecolor')
    expect(palette.accent('dsh')).toBe('\x1b[38;2;77;107;254mdsh\x1b[39m')
    expect(palette.error('x')).toBe('\x1b[38;2;248;81;73mx\x1b[39m')
  })

  it('draws the 256 tier with indexed sequences', () => {
    const palette = createPalette(true, '256')
    expect(palette.accent('dsh')).toBe('\x1b[38;5;69mdsh\x1b[39m')
  })

  it('draws the 16 tier with plain ANSI foregrounds', () => {
    const palette = createPalette(true, '16')
    expect(palette.user('text')).toBe('\x1b[36mtext\x1b[39m')
    expect(palette.success('ok')).toBe('\x1b[32mok\x1b[39m')
  })

  it('keeps selection as reverse video at every colored tier', () => {
    for (const depth of ['truecolor', '256', '16'] as const) {
      expect(createPalette(true, depth).selected('row')).toBe('\x1b[7mrow\x1b[27m')
    }
  })

  it('draws the colorless rung when colorDepth is none, even with color on', () => {
    // resolveColorDepth yields undefined for `none`; the terminal palette must
    // treat that as the colorless rung rather than dropping to the 16-color
    // tier, or a `colorDepth: none` config would still emit SGR.
    const env = { COLORTERM: 'truecolor' }
    expect(resolveColorDepth(true, 'none', env)).toBeUndefined()
    const palette = createTerminalPalette(true, 'none', env)
    expect(palette.error('boom')).toBe('boom')
    expect(palette.accent('dsh')).toBe('dsh')
    expect(palette.selected('row')).toBe('row')
  })
})

describe('resolveColorDepth', () => {
  const env = { COLORTERM: 'truecolor' }

  it('yields no depth for a colorless palette regardless of the override', () => {
    expect(resolveColorDepth(false, 'truecolor', env)).toBeUndefined()
    expect(resolveColorDepth(false, 'auto', env)).toBeUndefined()
  })

  it('yields no depth when the override is none', () => {
    expect(resolveColorDepth(true, 'none', env)).toBeUndefined()
  })

  it('pins the stated depth over what the terminal advertises', () => {
    expect(resolveColorDepth(true, '16', env)).toBe('16')
    expect(resolveColorDepth(true, '256', {})).toBe('256')
  })

  it('detects the depth from the environment under auto', () => {
    expect(resolveColorDepth(true, 'auto', env)).toBe('truecolor')
    expect(resolveColorDepth(true, 'auto', { TERM: 'xterm-256color' })).toBe('256')
    expect(resolveColorDepth(true, 'auto', {})).toBe('16')
  })
})
