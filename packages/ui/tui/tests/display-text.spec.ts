import { describe, expect, it } from 'vitest'
import { displayLine, displayText } from '../src/display-text.ts'

describe('displayText', () => {
  it('keeps ordinary text and line feeds intact', () => {
    expect(displayText('hello\nworld')).toBe('hello\nworld')
  })

  it('renders an escape sequence visibly instead of letting it reach the terminal', () => {
    expect(displayText('\x1b[2Jgone')).toBe('\\x1b[2Jgone')
  })

  it('escapes DEL and C1 controls', () => {
    expect(displayText('a\x7fb\u009fc')).toBe('a\\x7fb\\x9fc')
  })

  it('collapses CRLF and a lone CR without inventing a blank line', () => {
    expect(displayText('a\r\nb\rc')).toBe('a\nbc')
  })

  it('expands tabs to the next eight-column stop', () => {
    expect(displayText('a\tb')).toBe('a       b')
    expect(displayText('abcdefgh\ti')).toBe('abcdefgh        i')
  })

  it('restarts tab stops after a line break', () => {
    expect(displayText('abcdefg\nx\ty')).toBe('abcdefg\nx       y')
  })

  it('keeps non-ASCII text unchanged', () => {
    const text = '日本語 · émoji \u{1f389}'
    expect(displayText(text)).toBe(text)
  })
})

describe('displayLine', () => {
  it('folds line breaks into spaces for one-line slots', () => {
    expect(displayLine('a\nb\nc')).toBe('a b c')
  })

  it('still escapes the controls a pane title would otherwise obey', () => {
    expect(displayLine('title\x1b]0;evil\x07')).toBe('title\\x1b]0;evil\\x07')
  })
})
