import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { createPalette } from '../src/theme.ts'
import { Transcript } from '../src/transcript.ts'
import type { ToolOutcome, TranscriptEntry } from '../src/transcript.ts'
import { TranscriptView, type ToolPresenter } from '../src/view.ts'

const palette = createPalette(false)

/** A presenter that answers from fixed views and counts its lookups. */
function presenter(over: Partial<ToolPresenter> = {}): ToolPresenter & { calls: number } {
  const stub = {
    calls: 0,
    presentCall(): ToolCallView | undefined {
      stub.calls += 1
      return undefined
    },
    presentResult(): ToolResultView | undefined { return undefined },
    ...over,
  }
  return stub
}

/** A transcript whose entries are pushed directly, so the view is what is under test. */
function viewOver(entries: TranscriptEntry[], tools: Partial<ToolPresenter> = {}): TranscriptView {
  const transcript = new Transcript()
  const items = transcript.entries as TranscriptEntry[]
  items.push(...entries)
  return new TranscriptView(transcript, { palette, presenter: presenter(tools) })
}

const outcome: ToolOutcome = { content: [{ type: 'text', text: 'done' }], isError: false }

describe('TranscriptView', () => {
  it('marks the reader own turns', () => {
    expect(viewOver([{ kind: 'user', text: 'hello' }]).render(40)).toEqual(['› hello', ''])
  })

  it('renders assistant text as markdown', () => {
    const lines = viewOver([{ kind: 'assistant', text: '# Title', streaming: false }]).render(40)
    expect(lines.join('\n')).toContain('Title')
  })

  it('hides reasoning until the reader asks for it', () => {
    const view = viewOver([
      { kind: 'reasoning', text: 'thinking', streaming: true },
      { kind: 'assistant', text: 'answer', streaming: false },
    ])
    expect(view.render(40).join('\n')).not.toContain('thinking')
    view.reasoning = true
    expect(view.render(40).join('\n')).toContain('thinking')
  })

  it('wraps a long line to the viewport', () => {
    const lines = viewOver([{ kind: 'notice', tone: 'info', text: 'a'.repeat(30) }]).render(12)
    expect(lines.filter(line => line !== '').length).toBeGreaterThan(1)
  })

  it.each([['info'], ['warn'], ['error']] as const)('draws a %s notice', (tone) => {
    expect(viewOver([{ kind: 'notice', tone, text: 'note' }]).render(40)).toEqual(['note', ''])
  })

  it('draws a tool card through the owning tool presenters', () => {
    const view = viewOver([{
      kind: 'tool', callId: CallId('c1'), name: 'bash', rawArguments: '{}', outcome,
    }], {
      presentCall: () => ({ card: 'generic', title: 'Run ls' }),
      presentResult: () => ({ card: 'generic', title: 'Ran ls' }),
    })
    expect(view.render(40)[0]).toBe('✓ Ran ls')
  })

  it('leaves a running card without a result lookup', () => {
    let resultLookups = 0
    const view = viewOver([{ kind: 'tool', callId: CallId('c1'), name: 'bash', rawArguments: '{}' }], {
      presentResult: () => { resultLookups += 1; return undefined },
    })
    expect(view.render(40)[0]).toBe('· bash')
    expect(resultLookups).toBe(0)
  })

  it('reuses an entry render until its content changes', () => {
    const entry: TranscriptEntry = {
      kind: 'tool', callId: CallId('c1'), name: 'bash', rawArguments: '{}',
    }
    let lookups = 0
    const view = viewOver([entry], {
      presentCall: () => { lookups += 1; return undefined },
    })
    view.render(40)
    view.render(40)
    expect(lookups).toBe(1)
    entry.outcome = outcome
    view.render(40)
    expect(lookups).toBe(2)
  })

  it('redraws every entry when the width changes', () => {
    let lookups = 0
    const view = viewOver([{ kind: 'tool', callId: CallId('c1'), name: 'bash', rawArguments: '{}' }], {
      presentCall: () => { lookups += 1; return undefined },
    })
    view.render(40)
    view.render(20)
    expect(lookups).toBe(2)
  })

  it('redraws when the reader toggles reasoning or card expansion', () => {
    let lookups = 0
    const view = viewOver([{ kind: 'tool', callId: CallId('c1'), name: 'bash', rawArguments: '{}' }], {
      presentCall: () => { lookups += 1; return undefined },
    })
    view.render(40)
    view.reasoning = true
    view.render(40)
    view.expanded = true
    view.render(40)
    expect(lookups).toBe(3)
  })

  it('refolds a card body when the reader expands cards', () => {
    const long = { content: [{ type: 'text' as const, text: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15' }], isError: false }
    const view = viewOver([{
      kind: 'tool', callId: CallId('c1'), name: 'bash', rawArguments: '{}', outcome: long,
    }])
    const folded = view.render(40).length
    view.expanded = true
    expect(view.render(40).length).toBeGreaterThan(folded)
  })

  it('drops cached markdown state on invalidate', () => {
    const view = viewOver([{ kind: 'assistant', text: 'text', streaming: false }])
    view.render(40)
    expect(() => { view.invalidate() }).not.toThrow()
  })

  it('refuses an entry kind it does not draw', () => {
    const view = viewOver([{ kind: 'from-a-newer-build' } as unknown as TranscriptEntry])
    expect(() => view.render(40)).toThrow('unhandled transcript entry')
  })
})
