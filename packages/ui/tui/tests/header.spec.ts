import { describe, expect, it } from 'vitest'
import { composeColdOpen, readPackageVersion, type ColdOpenInput } from '../src/header.ts'
import { createPalette } from '../src/theme.ts'

const strip = (line: string): string => line.replaceAll(/\x1b\[[0-9;]*m/gu, '')

function input(over: Partial<ColdOpenInput> = {}): ColdOpenInput {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    permissionPreset: 'workspace-write',
    cwd: '/workspace/project',
    depth: 'truecolor',
    columns: 100,
    rows: 30,
    ...over,
  }
}

const styled = createPalette(true, 'truecolor')
const plain = createPalette(false)

describe('readPackageVersion', () => {
  it('reads the checked-in manifest version', () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/u)
  })
})

describe('composeColdOpen', () => {
  it('places the whale beside the identity on a wide terminal', () => {
    const lines = composeColdOpen(input(), styled).map(strip)
    expect(lines.length).toBe(10)
    expect(lines.some(line => line.includes('DeepSeek Harness'))).toBe(true)
    expect(lines.some(line => line.includes('deepseek-official/deepseek-v4-flash'))).toBe(true)
    expect(lines.some(line => line.includes('/workspace/project'))).toBe(true)
    expect(lines.some(line => line.includes('workspace-write'))).toBe(true)
    expect(lines.some(line => line.includes('/ for commands'))).toBe(true)
    // The whale shares every row with nothing but the identity column.
    expect(lines.some(line => line.includes('█'))).toBe(true)
  })

  it('styles the name and dims the facts', () => {
    const lines = composeColdOpen(input(), styled)
    const name = lines.find(line => strip(line).includes('DeepSeek Harness'))!
    expect(name).toContain('\x1b[1m')
    const route = lines.find(line => strip(line).includes('deepseek-official/deepseek-v4-flash'))!
    expect(route).toContain('\x1b[2m')
  })

  it('stacks the whale above the identity when there is no room beside it', () => {
    const lines = composeColdOpen(input({ columns: 70, rows: 24 }), styled).map(strip)
    const nameRow = lines.findIndex(line => line.includes('DeepSeek Harness'))
    const whaleRows = lines.slice(0, nameRow).filter(line => line.trim() !== '')
    expect(whaleRows.length).toBe(10)
    expect(lines).toHaveLength(nameRow + 4)
  })

  it('collapses to one line on a narrow terminal', () => {
    const lines = composeColdOpen(input({ columns: 50 }), styled).map(strip)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('DeepSeek Harness')
  })

  it('collapses to one line when the depth cannot carry the whale', () => {
    const lines = composeColdOpen(input({ depth: '16' }), createPalette(true, '16')).map(strip)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('deepseek-official/deepseek-v4-flash')
    const none = composeColdOpen(input({ depth: undefined }), plain).map(strip)
    expect(none).toHaveLength(1)
  })

  it('collapses to one line on a low terminal', () => {
    expect(composeColdOpen(input({ rows: 10 }), styled)).toHaveLength(1)
  })

  it('omits the preset row when the composition mounts none', () => {
    const lines = composeColdOpen(input({ permissionPreset: undefined }), styled).map(strip)
    expect(lines.some(line => line.includes('workspace-write'))).toBe(false)
  })

  it('escapes control characters in the session facts', () => {
    const lines = composeColdOpen(input({ cwd: '/a\x1b[31m' }), styled).map(strip)
    expect(lines.some(line => line.includes('\\x1b[31m'))).toBe(true)
    expect(lines.join('')).not.toContain('\x1b[31m')
  })

  it('renders the one-line header unstyled when color is off', () => {
    const lines = composeColdOpen(input({ depth: undefined }), plain)
    expect(lines.join('')).not.toContain('\x1b[')
  })
})
