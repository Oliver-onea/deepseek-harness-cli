import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { renderToolCard, shortArgs, type CardLayout, type ToolCard } from '../src/tool-card.ts'
import { createPalette } from '../src/theme.ts'
import type { ToolOutcome } from '../src/transcript.ts'

const palette = createPalette(false)
const layout: CardLayout = { headLines: 2, tailLines: 1, expanded: false }

function card(over: Partial<ToolCard> = {}): ToolCard {
  return { name: 'bash', rawArguments: '', call: undefined, result: undefined, outcome: undefined, ...over }
}

function textOutcome(text: string, isError = false): ToolOutcome {
  return { content: [{ type: 'text', text }], isError }
}

describe('renderToolCard', () => {
  it('falls back to the tool name while a call with no view runs', () => {
    expect(renderToolCard(card(), palette, layout)).toEqual(['· bash'])
  })

  it('titles a pending call from its own view', () => {
    const call: ToolCallView = { card: 'generic', title: 'List files', kind: 'read' }
    expect(renderToolCard(card({ call }), palette, layout)).toEqual(['· List files'])
  })

  it('marks a settled call, keeping the call line and attaching the result title', () => {
    const call: ToolCallView = { card: 'generic', title: 'Running' }
    const result: ToolResultView = { card: 'generic', title: 'Listed 3 files' }
    const lines = renderToolCard(card({ call, result, outcome: textOutcome('a\nb\nc') }), palette, layout)
    expect(lines).toEqual(['✓ Running', '╰ Listed 3 files', '  a', '  b', '  c'])
  })

  it('colors the elbow line for a failed result', () => {
    const colored = createPalette(true, 'truecolor')
    const call: ToolCallView = { card: 'generic', title: 'Running' }
    const result: ToolResultView = { card: 'generic', title: 'exit code 1' }
    const lines = renderToolCard(card({ call, result, outcome: textOutcome('boom', true) }), colored, layout)
    expect(lines[0]).toBe('\x1b[38;2;248;81;73m✗\x1b[39m \x1b[38;2;217;70;239mRunning\x1b[39m')
    expect(lines[1]).toBe(`╰ ${colored.error('exit code 1')}`)
  })

  it('drops the elbow when the result title repeats the call title', () => {
    const call: ToolCallView = { card: 'generic', title: 'Same' }
    const result: ToolResultView = { card: 'generic', title: 'Same' }
    const lines = renderToolCard(card({ call, result, outcome: textOutcome('done') }), palette, layout)
    expect(lines).toEqual(['✓ Same', '  done'])
  })

  it('names an unpresented call as name(args)', () => {
    const lines = renderToolCard(card({ rawArguments: '{"command":"git status"}' }), palette, layout)
    expect(lines).toEqual(['· bash (git status)'])
  })

  it('marks a failed call', () => {
    expect(renderToolCard(card({ outcome: textOutcome('boom', true) }), palette, layout)[0]).toBe('✗ bash')
  })

  it('renders the model-facing result when the tool presents no view', () => {
    expect(renderToolCard(card({ outcome: textOutcome('one\ntwo\n') }), palette, layout))
      .toEqual(['✓ bash', '  one', '  two'])
  })

  it('shows a pending terminal card description and its captured output afterwards', () => {
    const call: ToolCallView = { card: 'terminal', title: 'ls -la', description: 'list the workspace' }
    expect(renderToolCard(card({ call }), palette, layout))
      .toEqual(['· ls -la', '  list the workspace'])
    const result: ToolResultView = { card: 'terminal', output: 'a.txt', exitCode: 0 }
    expect(renderToolCard(card({ call, result, outcome: textOutcome('a.txt') }), palette, layout))
      .toEqual(['✓ ls -la', '  a.txt'])
  })

  it('draws a pending terminal card with no description as its title alone', () => {
    const call: ToolCallView = { card: 'terminal', title: 'ls' }
    expect(renderToolCard(card({ call }), palette, layout)).toEqual(['· ls'])
  })

  it('draws a diff as removed and added lines under the file path', () => {
    const call: ToolCallView = {
      card: 'diff',
      title: 'Edit a.txt',
      diffs: [{ path: 'a.txt', oldText: 'before', newText: 'after' }],
    }
    expect(renderToolCard(card({ call }), palette, { ...layout, expanded: true }))
      .toEqual(['· Edit a.txt', '  a.txt', '  - before', '  + after'])
  })

  it('omits the removed side for a created file', () => {
    const result: ToolResultView = {
      card: 'diff',
      diffs: [{ path: 'new.txt', oldText: null, newText: 'hello' }],
    }
    expect(renderToolCard(card({ result, outcome: textOutcome('ok') }), palette, layout))
      .toEqual(['✓ bash', '  new.txt', '  + hello'])
  })

  it('numbers the lines of a read result', () => {
    const result: ToolResultView = {
      card: 'read',
      path: 'a.ts',
      offset: 10,
      totalLines: 40,
      lines: [{ number: 10, text: 'const a = 1' }],
    }
    expect(renderToolCard(card({ result, outcome: textOutcome('') }), palette, layout))
      .toEqual(['✓ bash', '     10 const a = 1'])
  })

  it('lists search paths and groups content matches by file', () => {
    const paths: ToolResultView = { card: 'search', shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 }
    expect(renderToolCard(card({ result: paths, outcome: textOutcome('') }), palette, layout))
      .toEqual(['✓ bash', '  a.ts'])
    const matches: ToolResultView = {
      card: 'search',
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'needle' }] }],
      truncated: false,
      total: 1,
    }
    expect(renderToolCard(card({ result: matches, outcome: textOutcome('') }), palette, layout))
      .toEqual(['✓ bash', '  a.ts', '      3 needle'])
  })

  it('summarizes web retrieval by source and by response', () => {
    const search: ToolResultView = {
      card: 'web',
      kind: 'search',
      sources: [{ url: 'https://example.test/a', title: 'Example A' }, { url: 'https://example.test/b' }],
      truncated: false,
    }
    expect(renderToolCard(card({ result: search, outcome: textOutcome('') }), palette, layout))
      .toEqual(['✓ bash', '  Example A', '  https://example.test/b'])
    const fetched: ToolResultView = {
      card: 'web', kind: 'fetch', url: 'https://example.test/a', statusCode: 200, truncated: false,
    }
    expect(renderToolCard(card({ result: fetched, outcome: textOutcome('') }), palette, layout))
      .toEqual(['✓ bash', '  200 https://example.test/a'])
  })

  it('prefers the generic view content over the raw result', () => {
    const result: ToolResultView = { card: 'generic', content: [{ type: 'text', text: 'reformatted' }] }
    expect(renderToolCard(card({ result, outcome: textOutcome('raw') }), palette, layout))
      .toEqual(['✓ bash', '  reformatted'])
  })

  it('falls back to the raw result for a card shape it does not know', () => {
    const result = { card: 'from-a-newer-build' } as unknown as ToolResultView
    expect(renderToolCard(card({ result, outcome: textOutcome('raw') }), palette, layout))
      .toEqual(['✓ bash', '  raw'])
    const call = { card: 'from-a-newer-build', title: 'New' } as unknown as ToolCallView
    expect(renderToolCard(card({ call }), palette, layout)).toEqual(['· New'])
  })

  it('draws only the text blocks of a mixed-content result', () => {
    const outcome: ToolOutcome = {
      content: [
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('a1'),
            mediaType: 'image/png',
            bytes: 12,
            width: 4,
            height: 4,
          },
        },
        { type: 'text', text: 'caption' },
      ],
      isError: false,
    }
    expect(renderToolCard(card({ outcome }), palette, layout))
      .toEqual(['✓ bash', '  caption'])
  })

  it('draws a terminal result that captured no output as its header alone', () => {
    const result: ToolResultView = { card: 'terminal', exitCode: 0 }
    expect(renderToolCard(card({ result, outcome: textOutcome('') }), palette, layout))
      .toEqual(['✓ bash'])
  })

  it('folds a long body to its head and tail with the hidden count', () => {
    expect(renderToolCard(card({ outcome: textOutcome('1\n2\n3\n4\n5\n6') }), palette, layout))
      .toEqual(['✓ bash', '  1', '  2', '  … 3 more lines', '  6'])
  })

  it('keeps a body that would only just fit whole', () => {
    expect(renderToolCard(card({ outcome: textOutcome('1\n2\n3\n4') }), palette, layout))
      .toEqual(['✓ bash', '  1', '  2', '  3', '  4'])
  })

  it('draws the whole body once the reader expands cards', () => {
    const lines = renderToolCard(card({ outcome: textOutcome('1\n2\n3\n4\n5\n6') }), palette, { ...layout, expanded: true })
    expect(lines).toHaveLength(7)
  })
})

describe('shortArgs', () => {
  it('prefers an identifying field over later ones', () => {
    expect(shortArgs('{"command":"ls -la","cwd":"/w"}')).toBe(' (ls -la)')
    expect(shortArgs('{"pattern":"*.ts","path":"src"}')).toBe(' (*.ts)')
  })

  it('falls back to the first string value', () => {
    expect(shortArgs('{"note":"ship it","count":3}')).toBe(' (ship it)')
  })

  it('returns nothing for unidentifying arguments', () => {
    expect(shortArgs('{}')).toBe('')
    expect(shortArgs('{"count":3}')).toBe('')
    expect(shortArgs('not json')).toBe('')
    expect(shortArgs('42')).toBe('')
  })

  it('truncates a long argument and sanitizes control characters', () => {
    expect(shortArgs(JSON.stringify({ command: 'a'.repeat(60) }))).toBe(` (${'a'.repeat(40)}…)`)
    expect(shortArgs('{"command":"git\\u001b[31m"}')).toBe(' (git\\x1b[31m)')
  })
})
