import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StartupRefusalError } from '@deepseek-ai/dsh-app-boot/errors'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import {
  commandItems,
  displayItem,
  menuRowsFor,
  resolveFileFinder,
  TerminalAutocomplete,
} from '../src/autocomplete.ts'

/** A query's signal; nothing here aborts. */
function signal(): AbortSignal {
  return new AbortController().signal
}

/** Build the wrapper over a mutable roster the way the shell does. */
function buildMenus(over: {
  roster?: CommandDescriptor[]
  rows?: number
  fileFinderPath?: string | null
  workspacePath?: string
  maxVisible?: number
} = {}): {
  provider: TerminalAutocomplete
  roster: CommandDescriptor[]
  synced: number[]
} {
  const roster = over.roster ?? [
    { name: 'compact', description: 'Summarize the conversation' },
    { name: 'exit', description: 'Leave the terminal session' },
  ]
  const synced: number[] = []
  const autocomplete = new TerminalAutocomplete({
    commands: () => roster,
    workspacePath: over.workspacePath ?? tmpdir(),
    fileFinderPath: over.fileFinderPath ?? null,
    maxVisible: over.maxVisible ?? 8,
    rows: () => over.rows ?? 24,
    syncMaxVisible: (visible) => { synced.push(visible) },
  })
  return { provider: autocomplete, roster, synced }
}

describe('menuRowsFor', () => {
  it.each([
    [24, 8, 8],
    [12, 8, 6],
    [8, 8, 2],
    [7, 8, 1],
    [6, 8, 0],
    [5, 8, 0],
    [1, 8, 0],
    [24, 2, 2],
  ])('bounds a %s-row terminal configured for %s rows to %s rows', (rows, configured, expected) => {
    expect(menuRowsFor(rows, configured)).toBe(expected)
  })
})

describe('commandItems', () => {
  it('carries each descriptor with its hint as a slash-command candidate', () => {
    expect(commandItems([
      { name: 'goal', description: 'set or view the goal', input: { hint: '[<objective>]' } },
    ])).toEqual([{ name: 'goal', description: 'set or view the goal', argumentHint: '[<objective>]' }])
  })

  it('normalizes registry text that carries control characters', () => {
    const [item] = commandItems([
      { name: 'goal', description: 're\x1b[2Jpaint', input: { hint: 'a\tb' } },
    ])
    expect(item?.description).not.toContain('\x1b')
    expect(item?.argumentHint).not.toContain('\t')
  })
})

describe('displayItem', () => {
  it('normalizes the drawn text and keeps the completion value literal', () => {
    expect(displayItem({
      value: '@dir/we\x1bird name.md',
      label: 'we\x1bird name.md\n',
      description: 'dir/we\x1bird name.md',
    })).toEqual({
      value: '@dir/we\x1bird name.md',
      label: 'we\\x1bird name.md ',
      description: 'dir/we\\x1bird name.md',
    })
  })

  it('keeps an undescribed candidate undescribed', () => {
    expect(displayItem({ value: '/exit', label: 'exit' })).toEqual({ value: '/exit', label: 'exit' })
  })
})

describe('TerminalAutocomplete', () => {
  it('offers the roster under a slash prefix with descriptions', async () => {
    const { provider } = buildMenus()
    const suggestions = await provider.getSuggestions(['/co'], 0, 3, { signal: signal() })
    expect(suggestions).toMatchObject({ prefix: '/co', items: [{ value: 'compact' }] })
    expect(suggestions?.items[0]?.description).toBe('Summarize the conversation')
  })

  it('reads the roster live, so a later registration appears without a restart', async () => {
    const { provider, roster } = buildMenus()
    roster.push({ name: 'goal', description: 'set or view the goal' })
    const suggestions = await provider.getSuggestions(['/go'], 0, 3, { signal: signal() })
    expect(suggestions?.items.map(item => item.value)).toEqual(['goal'])
  })

  it('offers nothing under a slash prefix no command matches', async () => {
    const { provider } = buildMenus()
    expect(await provider.getSuggestions(['/zz'], 0, 3, { signal: signal() })).toBeNull()
  })

  it('applies the row bound before serving, and refuses when no row remains', async () => {
    const { provider, synced } = buildMenus({ rows: 5 })
    expect(await provider.getSuggestions(['/'], 0, 1, { signal: signal() })).toBeNull()
    expect(synced).toEqual([0])
    const tall = buildMenus({ rows: 8 })
    expect(await tall.provider.getSuggestions(['/'], 0, 1, { signal: signal() })).not.toBeNull()
    expect(tall.synced).toEqual([2])
  })

  it('applies a slash pick through the delegate', () => {
    const { provider } = buildMenus()
    expect(provider.applyCompletion(
      ['/co'], 0, 3, { value: 'compact', label: 'compact' }, '/co',
    )).toEqual({ lines: ['/compact '], cursorLine: 0, cursorCol: 9 })
  })

  it('applies a file pick through the delegate', () => {
    const { provider } = buildMenus()
    expect(provider.applyCompletion(
      ['see @al'], 0, 7, { value: '@alpha.md', label: 'alpha.md' }, '@al',
    )).toEqual({ lines: ['see @alpha.md '], cursorLine: 0, cursorCol: 14 })
  })

  it('defers forced-trigger eligibility to the delegate', () => {
    const { provider } = buildMenus()
    expect(provider.shouldTriggerFileCompletion(['/he'], 0, 3)).toBe(false)
    expect(provider.shouldTriggerFileCompletion(['see '], 0, 4)).toBe(true)
  })

  it.skipIf(resolveFileFinder(undefined) === null)('offers workspace files under an @ prefix through the file finder', async () => {
    const finder = resolveFileFinder(undefined)
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-tui-at-menu-'))
    try {
      writeFileSync(join(workspace, 'alpha-notes.md'), 'notes')
      writeFileSync(join(workspace, 'beta-code.ts'), 'code')
      const { provider } = buildMenus({ workspacePath: workspace, fileFinderPath: finder })
      const suggestions = await provider.getSuggestions(['@alpha'], 0, 6, { signal: signal() })
      expect(suggestions?.items.map(item => item.value)).toContain('@alpha-notes.md')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('offers no @ menu when no file finder is available', async () => {
    const { provider } = buildMenus({ fileFinderPath: null })
    expect(await provider.getSuggestions(['@alpha'], 0, 6, { signal: signal() })).toBeNull()
  })
})

describe('resolveFileFinder', () => {
  const originalPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('finds the first file finder on PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-tui-finder-'))
    try {
      const finder = join(directory, 'fd')
      writeFileSync(finder, '#!/bin/sh\n')
      chmodSync(finder, 0o755)
      process.env.PATH = directory
      expect(resolveFileFinder(undefined)).toBe(finder)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('answers null when PATH carries no finder', () => {
    process.env.PATH = ''
    expect(resolveFileFinder(undefined)).toBeNull()
  })

  it('answers null when PATH is unset', () => {
    delete process.env.PATH
    expect(resolveFileFinder(undefined)).toBeNull()
  })

  it('takes an explicit path that exists', () => {
    expect(resolveFileFinder(process.execPath)).toBe(process.execPath)
  })

  it('refuses startup for an explicit path that does not exist', () => {
    expect(() => resolveFileFinder('/nonexistent/fd')).toThrow(StartupRefusalError)
    expect(() => resolveFileFinder('/nonexistent/fd')).toThrow('fileFinderPath "/nonexistent/fd" does not exist')
  })
})
