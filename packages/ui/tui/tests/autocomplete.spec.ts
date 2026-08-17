import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import {
  atTokenOf,
  childDisplayName,
  childRunning,
  commandItems,
  menuRowsFor,
  skillItems,
  TerminalAutocomplete,
  type MenuSkill,
  type RunningChild,
} from '../src/autocomplete.ts'

/** A query's signal; nothing here aborts. */
function signal(): AbortSignal {
  return new AbortController().signal
}

/** Build the menus over a mutable roster the way the shell does. */
function buildMenus(over: {
  roster?: CommandDescriptor[]
  children?: readonly RunningChild[]
  skills?: readonly MenuSkill[] | false
  rows?: number
  maxVisible?: number
  subagents?: boolean
} = {}): {
  provider: TerminalAutocomplete
  roster: CommandDescriptor[]
  children: readonly RunningChild[]
  skills: MenuSkill[]
  synced: number[]
} {
  const roster = over.roster ?? [
    { name: 'compact', description: 'Summarize the conversation' },
    { name: 'exit', description: 'Leave the terminal session' },
  ]
  const children = over.children ?? []
  const skills = over.skills === false ? [] : [...over.skills ?? []]
  const synced: number[] = []
  const autocomplete = new TerminalAutocomplete({
    commands: () => roster,
    skills: over.skills === false
      ? undefined
      : async () => skills,
    subagents: over.subagents === false
      ? undefined
      : async () => children,
    maxVisible: over.maxVisible ?? 8,
    rows: () => over.rows ?? 24,
    syncMaxVisible: (visible) => { synced.push(visible) },
  })
  return { provider: autocomplete, roster, children, skills, synced }
}

/** A listed child entry, as the subagent roster supplies one. */
function childEntry(over: { id?: string; label?: string | undefined; activity?: 'running' | 'inactive' } = {}): SubagentListEntry & { readonly kind: 'child' } {
  return {
    kind: 'child',
    id: SessionId(over.id ?? 'session-child'),
    activity: over.activity ?? 'running',
    hasChildren: false,
    mode: 'one-shot',
    ...over.label === undefined ? {} : { label: over.label },
  }
}

/** A live agent stand-in whose session may carry a logged title. */
function childAgent(status: 'idle' | 'running', title?: string): Agent {
  const session = Session.create(SessionId('session-child'))
  if (title !== undefined) {
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'fallback' } })
  }
  return { session, status } as unknown as Agent
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
  it('carries each descriptor with its hint folded into the description', () => {
    expect(commandItems([
      { name: 'goal', description: 'set or view the goal', input: { hint: '[<objective>]' } },
      { name: 'compact', description: 'Summarize the conversation' },
    ])).toEqual([
      { value: 'goal', label: 'goal', description: '[<objective>] — set or view the goal' },
      { value: 'compact', label: 'compact', description: 'Summarize the conversation' },
    ])
  })

  it('normalizes registry text that carries control characters', () => {
    const [item] = commandItems([
      { name: 'goal', description: 're\x1b[2Jpaint', input: { hint: 'a\tb' } },
    ])
    expect(item?.description).not.toContain('\x1b')
    expect(item?.description).not.toContain('\t')
  })
})

describe('skillItems', () => {
  it('carries each skill, marking one the model catalog omits as user-only', () => {
    expect(skillItems([
      { name: 'commit-helper', description: 'Git commits', modelInvocable: true },
      { name: 'sign-off', description: 'Sign the release', modelInvocable: false },
    ])).toEqual([
      { value: 'commit-helper', label: 'commit-helper', description: 'Git commits' },
      { value: 'sign-off', label: 'sign-off', description: 'user-only — Sign the release' },
    ])
  })

  it('normalizes catalog text that carries control characters', () => {
    const [item] = skillItems([
      { name: 'evil', description: 're\x1b]0;hijack\x07paint', modelInvocable: false },
    ])
    expect(item?.label).toBe('evil')
    expect(item?.description).not.toContain('\x1b')
    expect(item?.description).not.toContain('\x07')
    expect(item?.description).toContain('\\x1b]0;hijack\\x07paint')
  })
})

describe('childDisplayName', () => {
  it('prefers the durable session title over the creation label over the id', () => {
    const titled = childEntry({ label: 'creation label' })
    expect(childDisplayName(titled, childAgent('running', 'durable title'))).toBe('durable title')
    expect(childDisplayName(titled, childAgent('running'))).toBe('creation label')
    expect(childDisplayName(childEntry({ label: undefined }), childAgent('running'))).toBe('session-child')
  })
})

describe('childRunning', () => {
  it('follows the live agent status when one is registered', () => {
    const entry = childEntry({ activity: 'running' })
    expect(childRunning(entry, childAgent('running'))).toBe(true)
    expect(childRunning(entry, childAgent('idle'))).toBe(false)
  })

  it('falls back to the store liveness for a child without a live agent', () => {
    expect(childRunning(childEntry({ activity: 'running' }), undefined)).toBe(true)
    expect(childRunning(childEntry({ activity: 'inactive' }), undefined)).toBe(false)
  })

  it('never runs a diagnostic entry', () => {
    const diagnostic = { kind: 'diagnostic', id: SessionId('session-child'), reason: 'corrupt' } as SubagentListEntry
    expect(childRunning(diagnostic, undefined)).toBe(false)
  })})

describe('atTokenOf', () => {
  it.each([
    ['@', '@'],
    ['see @al', '@al'],
    ['@full-name', '@full-name'],
    ['', null],
    ['see al', null],
    ['mail@host', null],
  ])('reads %j as %j', (beforeCursor, expected) => {
    expect(atTokenOf(beforeCursor)).toBe(expected)
  })
})

describe('TerminalAutocomplete', () => {
  it('offers the roster under a slash prefix with descriptions', async () => {
    const { provider } = buildMenus()
    const suggestions = await provider.getSuggestions(['/co'], 0, 3, { signal: signal() })
    expect(suggestions).toMatchObject({ prefix: '/co', items: [{ value: 'compact' }] })
    expect(suggestions?.items[0]?.description).toBe('Summarize the conversation')
  })

  it('lists skills after commands under a slash prefix', async () => {
    const { provider } = buildMenus({ skills: [{ name: 'commit-helper', description: 'Git commits', modelInvocable: true }] })
    const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: signal() })
    expect(suggestions?.items.map(item => item.value)).toEqual(['compact', 'exit', 'commit-helper'])
    expect(suggestions?.items[2]?.description).toBe('Git commits')
  })

  it('offers the commands alone when the composition mounts no skill capability', async () => {
    const { provider } = buildMenus({ skills: false })
    const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: signal() })
    expect(suggestions?.items.map(item => item.value)).toEqual(['compact', 'exit'])
  })

  it('narrows a slash query across commands and skills together', async () => {
    const { provider } = buildMenus({ skills: [{ name: 'compact-reports', description: 'Fold reports', modelInvocable: true }] })
    const suggestions = await provider.getSuggestions(['/comp'], 0, 5, { signal: signal() })
    expect(suggestions?.items.map(item => item.value)).toEqual(['compact', 'compact-reports'])
  })

  it('reads the skill catalog live, so a later registration appears without a restart', async () => {
    const { provider, skills } = buildMenus()
    skills.push({ name: 'commit-helper', description: 'Git commits', modelInvocable: true })
    const suggestions = await provider.getSuggestions(['/commit'], 0, 7, { signal: signal() })
    expect(suggestions?.items.map(item => item.value)).toEqual(['commit-helper'])
  })

  it('offers the commands alone when the catalog read fails', async () => {
    const provider = new TerminalAutocomplete({
      commands: () => [{ name: 'exit', description: 'Leave the terminal session' }],
      skills: () => Promise.reject(new Error('registry unavailable')),
      maxVisible: 8,
      rows: () => 24,
      syncMaxVisible: () => {},
    })
    const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: signal() })
    expect(suggestions?.items.map(item => item.value)).toEqual(['exit'])
  })

  it('offers nothing when the query aborted before the catalog answered', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = new TerminalAutocomplete({
      commands: () => [{ name: 'exit', description: 'Leave the terminal session' }],
      skills: async () => [{ name: 'commit-helper', description: 'Git commits', modelInvocable: true }],
      maxVisible: 8,
      rows: () => 24,
      syncMaxVisible: () => {},
    })
    await expect(provider.getSuggestions(['/'], 0, 1, { signal: controller.signal })).resolves.toBeNull()
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

  it('offers nothing for a slash on a later line or past the command name', async () => {
    const { provider } = buildMenus()
    expect(await provider.getSuggestions(['typed text', '/co'], 1, 3, { signal: signal() })).toBeNull()
    expect(await provider.getSuggestions(['/compact arg'], 0, 11, { signal: signal() })).toBeNull()
  })

  it('offers running children under an @ prefix', async () => {
    const { provider } = buildMenus({ children: [{ name: 'scan-runner' }, { name: 'fix-runner' }] })
    const suggestions = await provider.getSuggestions(['@scan'], 0, 5, { signal: signal() })
    expect(suggestions).toEqual({ prefix: '@scan', items: [{ value: 'scan-runner', label: 'scan-runner' }] })
  })

  it('offers nothing under @ when the composition mounts no subagent capability', async () => {
    const { provider } = buildMenus({ subagents: false })
    expect(await provider.getSuggestions(['@scan'], 0, 5, { signal: signal() })).toBeNull()
  })

  it('offers nothing under @ when the roster read fails', async () => {
    const provider = new TerminalAutocomplete({
      commands: () => [],
      subagents: () => Promise.reject(new Error('registry unavailable')),
      maxVisible: 8,
      rows: () => 24,
      syncMaxVisible: () => {},
    })
    await expect(provider.getSuggestions(['@'], 0, 1, { signal: signal() })).resolves.toBeNull()
  })

  it('offers nothing under @ with no running child matching', async () => {
    const { provider } = buildMenus({ children: [] })
    expect(await provider.getSuggestions(['@'], 0, 1, { signal: signal() })).toBeNull()
  })

  it('offers nothing when the query aborted before the roster answered', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = new TerminalAutocomplete({
      commands: () => [],
      subagents: async () => [{ name: 'scan-runner' }],
      maxVisible: 8,
      rows: () => 24,
      syncMaxVisible: () => {},
    })
    await expect(provider.getSuggestions(['@'], 0, 1, { signal: controller.signal })).resolves.toBeNull()
  })

  it('sanitizes an untrusted child name in both label and completion value', async () => {
    const { provider } = buildMenus({ children: [{ name: 'scan\x1b]0;evil\x07-runner' }] })
    const suggestions = await provider.getSuggestions(['@'], 0, 1, { signal: signal() })
    expect(suggestions?.items[0]?.label).toBe('scan\\x1b]0;evil\\x07-runner')
    expect(suggestions?.items[0]?.value).toBe('scan\\x1b]0;evil\\x07-runner')
    expect(suggestions?.items[0]?.label).not.toContain('\x1b')
  })

  it('applies the row bound before serving, and refuses when no row remains', async () => {
    const { provider, synced } = buildMenus({ rows: 5 })
    expect(await provider.getSuggestions(['/'], 0, 1, { signal: signal() })).toBeNull()
    expect(synced).toEqual([0])
    const tall = buildMenus({ rows: 8 })
    expect(await tall.provider.getSuggestions(['/'], 0, 1, { signal: signal() })).not.toBeNull()
    expect(tall.synced).toEqual([2])
  })

  it('applies a slash pick as the command line', () => {
    const { provider } = buildMenus()
    expect(provider.applyCompletion(
      ['/co'], 0, 3, { value: 'compact', label: 'compact' }, '/co',
    )).toEqual({ lines: ['/compact '], cursorLine: 0, cursorCol: 9 })
  })

  it('applies an @ pick as the verbatim reference with a trailing space', () => {
    const { provider } = buildMenus()
    expect(provider.applyCompletion(
      ['ask @scan'], 0, 9, { value: 'scan-runner', label: 'scan-runner' }, '@scan',
    )).toEqual({ lines: ['ask @scan-runner '], cursorLine: 0, cursorCol: 17 })
  })

  it('never triggers file completion', () => {
    const { provider } = buildMenus()
    expect(provider.shouldTriggerFileCompletion()).toBe(false)
  })
})
