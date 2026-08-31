import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { createPalette } from '../src/theme.ts'
import { Transcript } from '../src/transcript.ts'
import type { ToolOutcome, TranscriptEntry } from '../src/transcript.ts'
import { TranscriptView, type AttachmentImageReader, type ImageViewOptions, type ToolPresenter } from '../src/view.ts'

const palette = createPalette(false)

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('img-1'),
  mediaType: 'image/png',
  bytes: 4,
  width: 200,
  height: 100,
}

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

/** Default image options: no reader, so every image draws its text fallback. */
function imageOptions(over: Partial<ImageViewOptions> = {}): ImageViewOptions {
  return {
    reader: undefined,
    maxWidthCells: 60,
    maxHeightCells: undefined,
    requestRender: () => {},
    ...over,
  }
}

/** A transcript whose entries are pushed directly, so the view is what is under test. */
function viewOver(
  entries: TranscriptEntry[],
  tools: Partial<ToolPresenter> = {},
  images: Partial<ImageViewOptions> = {},
): TranscriptView {
  const transcript = new Transcript()
  const items = transcript.entries as TranscriptEntry[]
  items.push(...entries)
  return new TranscriptView(transcript, { palette, presenter: presenter(tools), images: imageOptions(images) })
}

/** A reader answering from a fixed byte payload, counting how many times it was asked. */
function fixedReader(data: Uint8Array | Error): AttachmentImageReader & { calls: number } {
  const stub = {
    calls: 0,
    async read(): Promise<Uint8Array> {
      stub.calls += 1
      if (data instanceof Error) throw data
      return data
    },
  }
  return stub
}

afterEach(() => {
  resetCapabilitiesCache()
})

const outcome: ToolOutcome = { content: [{ type: 'text', text: 'done' }], isError: false }

describe('TranscriptView', () => {
  it('marks the reader own turns', () => {
    expect(viewOver([{ kind: 'user', text: 'hello' }]).render(40)).toEqual(['› hello', ''])
  })

  it('marks the assistant first line and hangs the turn under it', () => {
    const lines = viewOver([{ kind: 'assistant', text: 'one two three four five six seven', streaming: false }]).render(24)
    expect(lines[0]).toMatch(/^◆ /u)
    expect(lines[1]).toMatch(/^ {2}\S/u)
  })

  it('styles the assistant marker with the palette accent', () => {
    const transcript = new Transcript()
    const items = transcript.entries as TranscriptEntry[]
    items.push({ kind: 'assistant', text: 'answer', streaming: false })
    const view = new TranscriptView(transcript, { palette: createPalette(true, 'truecolor'), presenter: presenter(), images: imageOptions() })
    expect(view.render(40)[0]).toContain('\x1b[38;2;77;107;254m◆\x1b[39m')
  })

  it('opens a blank line before each human and assistant turn', () => {
    const lines = viewOver([
      { kind: 'notice', tone: 'info', text: 'note' },
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'answer', streaming: false },
    ]).render(40).map(line => line.replace(/\s+$/u, ''))
    expect(lines).toEqual(['note', '', '', '› hello', '', '', '◆ answer', ''])
  })

  it('keeps the single separator before the first turn and after the header', () => {
    expect(viewOver([{ kind: 'user', text: 'first' }]).render(40)).toEqual(['› first', ''])
    const afterHeader = viewOver([
      { kind: 'header', lines: ['whale'] },
      { kind: 'user', text: 'next' },
    ]).render(40)
    expect(afterHeader).toEqual(['whale', '', '› next', ''])
  })

  it('draws the seeded cold-open header lines as they were composed', () => {
    const lines = viewOver([{ kind: 'header', lines: ['whale art', 'DeepSeek Harness'] }]).render(40)
    expect(lines).toEqual(['whale art', 'DeepSeek Harness', ''])
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
    const lines = view.render(40)
    expect(lines[0]).toBe('✓ Run ls')
    expect(lines[1]).toBe('╰ Ran ls')
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

  describe('inline images', () => {
    it('renders the text fallback when the terminal has no image protocol', () => {
      setCapabilities({ images: null, trueColor: false, hyperlinks: false })
      const lines = viewOver([{ kind: 'image', ref: imageRef }]).render(40)
      expect(lines.join('\n')).toMatch(/png/i)
    })

    it('carries a configured filename and max height into the fallback component', () => {
      setCapabilities({ images: null, trueColor: false, hyperlinks: false })
      const named: ImageAttachmentRef = { ...imageRef, name: 'chart.png' }
      const lines = viewOver([{ kind: 'image', ref: named }], {}, { maxHeightCells: 20 }).render(40)
      expect(lines.join('\n')).toContain('chart.png')
    })

    it('never asks the reader when the terminal has no image protocol', () => {
      setCapabilities({ images: null, trueColor: false, hyperlinks: false })
      const reader = fixedReader(new Uint8Array([1]))
      viewOver([{ kind: 'image', ref: imageRef }], {}, { reader }).render(40)
      expect(reader.calls).toBe(0)
    })

    it('renders the text fallback on a capable terminal when no attachment reader is composed', () => {
      setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true })
      expect(() => viewOver([{ kind: 'image', ref: imageRef }]).render(40)).not.toThrow()
    })

    it('loads bytes once on a capable terminal and asks for a redraw once they arrive', async () => {
      setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true })
      const reader = fixedReader(new Uint8Array([137, 80, 78, 71]))
      const requestRender = vi.fn()
      const view = viewOver([{ kind: 'image', ref: imageRef }], {}, { reader, requestRender })
      view.render(40)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(reader.calls).toBe(1)
      expect(requestRender).toHaveBeenCalledTimes(1)
      view.render(40)
      expect(reader.calls).toBe(1)
    })

    it('keeps the text fallback and settles quietly when the read fails', async () => {
      setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true })
      const reader = fixedReader(new Error('boom'))
      const view = viewOver([{ kind: 'image', ref: imageRef }], {}, { reader })
      view.render(40)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(reader.calls).toBe(1)
      expect(() => view.render(40)).not.toThrow()
      expect(reader.calls).toBe(1)
    })

    it('aborts an in-flight image read on dispose', () => {
      setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true })
      let signal: AbortSignal | undefined
      const reader: AttachmentImageReader = {
        read: (_ref, given) => {
          signal = given
          return new Promise(() => {})
        },
      }
      const view = viewOver([{ kind: 'image', ref: imageRef }], {}, { reader })
      view.render(40)
      expect(signal?.aborted).toBe(false)
      view.dispose()
      expect(signal?.aborted).toBe(true)
    })
  })
})
