import { describe, expect, it } from 'vitest'
import { renderWhale, whaleDepthSupported } from '../src/whale.ts'

describe('whaleDepthSupported', () => {
  it.each([
    ['truecolor', true],
    ['256', true],
    ['16', false],
    [undefined, false],
  ] as const)('depth %s carries the whale: %s', (depth, expected) => {
    expect(whaleDepthSupported(depth)).toBe(expected)
  })
})

describe('renderWhale', () => {
  it('draws the mark in the brand ink at truecolor', () => {
    const lines = renderWhale('truecolor')
    expect(lines).toBeDefined()
    for (const line of lines!) {
      if (line === '') continue
      expect(line.startsWith('\x1b[38;2;77;107;254m')).toBe(true)
      expect(line.endsWith('\x1b[39m')).toBe(true)
    }
  })

  it('draws the mark in the indexed ink at 256 colors', () => {
    const lines = renderWhale('256')
    expect(lines!.some(line => line.includes('\x1b[38;5;69m'))).toBe(true)
  })

  it('keeps the same silhouette at both drawable depths', () => {
    const strip = (line: string): string => line.replaceAll(/\x1b\[[0-9;]*m/gu, '')
    expect(renderWhale('truecolor')!.map(strip)).toEqual(renderWhale('256')!.map(strip))
  })

  it('drops the whale at the 16-color rung and under', () => {
    expect(renderWhale('16')).toBeUndefined()
    expect(renderWhale(undefined)).toBeUndefined()
  })

  it('uses only half-block cells and spaces', () => {
    for (const line of renderWhale('truecolor')!) {
      expect(line.replaceAll(/\x1b\[[0-9;]*m/gu, '')).toMatch(/^[█▀▄ ]*$/u)
    }
  })
})
