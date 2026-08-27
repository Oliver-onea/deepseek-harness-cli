/**
 * The transcript component: the {@link Transcript} fold drawn as terminal
 * lines. Rendered lines are cached per entry and invalidated by content or
 * width change, so redrawing a long conversation costs the entries that
 * actually moved rather than the whole history.
 * @module @deepseek-ai/dsh-tui/view
 */

import { Markdown, wrapTextWithAnsi, type Component, type MarkdownTheme } from '@earendil-works/pi-tui'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { renderToolCard, type CardLayout } from './tool-card.ts'
import type { Palette } from './theme.ts'
import { highlightCode } from './highlight.ts'
import type { ToolEntry, ToolOutcome, Transcript, TranscriptEntry } from './transcript.ts'

/** The tool-presentation lookups the view needs, supplied by the plugin. */
export interface ToolPresenter {
  /**
   * Resolve a pending call's view from the owning tool.
   * @param name - the registered tool name.
   * @param rawArguments - the raw arguments JSON the model produced.
   * @returns the tool's view, or `undefined` when it presents none.
   */
  presentCall(name: string, rawArguments: string): ToolCallView | undefined
  /**
   * Resolve a completed call's view from the owning tool.
   * @param name - the registered tool name.
   * @param rawArguments - the raw arguments JSON the model produced.
   * @param outcome - the settled model-facing outcome.
   * @returns the tool's view, or `undefined` when it presents none.
   */
  presentResult(name: string, rawArguments: string, outcome: ToolOutcome): ToolResultView | undefined
}

/** What the view needs beyond the transcript itself. */
export interface TranscriptViewOptions {
  /** The styles to draw with. */
  palette: Palette
  /** The tool-view lookups. */
  presenter: ToolPresenter
}

/** One entry's last render, reused until its content or the width changes. */
interface CachedLines {
  width: number
  /** Content fingerprint: an entry mutates in place while it streams. */
  revision: string
  /** Whether reasoning was shown when these lines were drawn. */
  reasoning: boolean
  /** Whether cards were expanded when these lines were drawn. */
  expanded: boolean
  lines: string[]
}

/**
 * Map the TUI palette to the markdown component's theme.
 * @param palette - the component's palette.
 * @returns the markdown theme.
 */
function markdownTheme(palette: Palette): MarkdownTheme {
  return {
    heading: palette.heading,
    link: palette.link,
    linkUrl: palette.dim,
    code: palette.code,
    codeBlock: palette.code,
    codeBlockBorder: palette.dim,
    quote: palette.quote,
    quoteBorder: palette.dim,
    hr: palette.dim,
    listBullet: palette.tool,
    bold: palette.bold,
    italic: palette.italic,
    strikethrough: palette.strikethrough,
    underline: palette.bold,
    highlightCode: (code, lang) => highlightCode(code, lang, palette),
  }
}

/**
 * A content fingerprint for one entry, cheap enough to compute every render.
 * @param entry - the transcript entry.
 * @returns a string that changes whenever the drawn content would.
 */
function revisionOf(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
    case 'notice':
      return entry.text
    case 'assistant':
    case 'reasoning':
      return `${entry.streaming ? '1' : '0'}${entry.text}`
    case 'tool':
      return `${entry.callId}:${entry.outcome === undefined ? 'run' : String(entry.outcome.isError)}:${entry.outcome?.content.length ?? 0}`
    case 'header':
      // The header is immutable once seeded.
      return 'header'
    // An entry kind this module cannot draw gets a constant fingerprint here
    // and is refused by `drawEntry`, the single guard for the closed union.
    default:
      return ''
  }
}

/**
 * Reject an entry kind this module does not draw.
 * @param entry - the unreachable value.
 * @returns never; always throws.
 */
function assertNever(entry: never): never {
  throw new Error(`dsh-tui: unhandled transcript entry ${JSON.stringify(entry)}`)
}

/** The marker prefixing the assistant's first line, rhyming the reader's `›`. */
const ASSISTANT_MARKER = '◆'

/** Columns the assistant marker and its hanging indent occupy. */
const MARKER_COLUMNS = 2

/** The transcript, drawn. */
export class TranscriptView implements Component {
  private readonly cache = new WeakMap<TranscriptEntry, CachedLines>()
  private readonly markdown: Markdown
  private readonly theme: MarkdownTheme
  /** Whether reasoning entries are drawn; toggled by a terminal control. */
  reasoning = false
  /** Whether tool cards draw their whole body; toggled by a terminal control. */
  expanded = false
  /** How much of a folded card body to draw. */
  layout: CardLayout = { headLines: 8, tailLines: 4, expanded: false }

  /**
   * @param transcript - the fold this component draws.
   * @param options - the styles and tool-view lookups.
   */
  constructor(
    private readonly transcript: Transcript,
    private readonly options: TranscriptViewOptions,
  ) {
    this.theme = markdownTheme(options.palette)
    this.markdown = new Markdown('', 0, 0, this.theme)
  }

  /** Drop every cached render; the next draw rebuilds from the fold. */
  invalidate(): void {
    this.markdown.invalidate()
  }

  /**
   * Draw the whole transcript.
   * @param width - the viewport width in columns.
   * @returns the drawn lines.
   */
  render(width: number): string[] {
    const lines: string[] = []
    let previous: TranscriptEntry | undefined
    for (const entry of this.transcript.entries) {
      if (entry.kind === 'reasoning' && !this.reasoning) continue
      if (this.turnGap(entry, previous)) lines.push('')
      lines.push(...this.linesFor(entry, width))
      previous = entry
    }
    return lines
  }

  /**
   * Whether one turn begins with an extra blank line before it. Spacing marks
   * the turn boundary; the editor frame owns the only horizontal rules.
   * @param entry - the entry about to draw.
   * @param previous - the entry drawn before it, when any.
   * @returns whether to open a blank line before this entry.
   */
  private turnGap(entry: TranscriptEntry, previous: TranscriptEntry | undefined): boolean {
    if (entry.kind !== 'user' && entry.kind !== 'assistant') return false
    // The first entry on screen and the entry after the cold-open header keep
    // the single separator they already have.
    if (previous === undefined || previous.kind === 'header') return false
    return true
  }

  /**
   * Draw one entry, reusing its last render when nothing it depends on changed.
   * @param entry - the entry to draw.
   * @param width - the viewport width in columns.
   * @returns the entry's lines, including its trailing blank separator.
   */
  private linesFor(entry: TranscriptEntry, width: number): string[] {
    const revision = revisionOf(entry)
    const cached = this.cache.get(entry)
    if (cached !== undefined
      && cached.width === width
      && cached.revision === revision
      && cached.reasoning === this.reasoning
      && cached.expanded === this.expanded) {
      return cached.lines
    }
    const lines = [...this.drawEntry(entry, width), '']
    this.cache.set(entry, {
      width, revision, lines,
      reasoning: this.reasoning,
      expanded: this.expanded,
    })
    return lines
  }

  /**
   * Draw one entry's own lines, without its separator.
   * @param entry - the entry to draw.
   * @param width - the viewport width in columns.
   * @returns the entry's lines.
   */
  private drawEntry(entry: TranscriptEntry, width: number): string[] {
    const palette = this.options.palette
    switch (entry.kind) {
      case 'user':
        return wrap(entry.text, width).map(line => `${palette.user('›')} ${line}`)
      case 'assistant':
        return this.drawAssistant(entry.text, width)
      case 'reasoning':
        return wrap(entry.text, width).map(line => palette.dim(line))
      case 'notice':
        return wrap(entry.text, width).map(line => toneOf(entry.tone, palette)(line))
      case 'header':
        return entry.lines.flatMap(line => wrap(line, width))
      case 'tool':
        return this.drawTool(entry, width)
      // Closed union over this module's own entry vocabulary.
      default:
        return assertNever(entry)
    }
  }

  /**
   * Draw one assistant turn: the marker colors the first line so turn
   * ownership is scannable, and the rest of the turn hangs under it.
   * @param text - the assistant text, already normalized.
   * @param width - the viewport width in columns.
   * @returns the turn's lines.
   */
  private drawAssistant(text: string, width: number): string[] {
    this.markdown.setText(text)
    const body = this.markdown.render(Math.max(1, width - MARKER_COLUMNS))
    if (body.length === 0) return body
    const palette = this.options.palette
    return body.map((line, index) => index === 0
      ? `${palette.accent(ASSISTANT_MARKER)} ${line}`
      : `${' '.repeat(MARKER_COLUMNS)}${line}`)
  }

  /**
   * Draw one tool card, resolving its views through the owning tool.
   * @param entry - the tool entry.
   * @param width - the viewport width in columns.
   * @returns the card's wrapped lines.
   */
  private drawTool(entry: ToolEntry, width: number): string[] {
    const presenter = this.options.presenter
    const outcome = entry.outcome
    const card = {
      name: entry.name,
      rawArguments: entry.rawArguments,
      call: presenter.presentCall(entry.name, entry.rawArguments),
      result: outcome === undefined
        ? undefined
        : presenter.presentResult(entry.name, entry.rawArguments, outcome),
      outcome,
    }
    const layout: CardLayout = { ...this.layout, expanded: this.expanded }
    return renderToolCard(card, this.options.palette, layout)
      .flatMap(line => wrap(line, width))
  }
}

/**
 * Pick the style one notice tone draws in.
 * @param tone - the notice's tone.
 * @param palette - the styles to pick from.
 * @returns the style for that tone.
 */
function toneOf(tone: 'info' | 'warn' | 'error', palette: Palette): (text: string) => string {
  if (tone === 'error') return palette.error
  if (tone === 'warn') return palette.warn
  return palette.dim
}

/**
 * Wrap already-normalized text to the viewport, preserving its own line breaks
 * and any SGR runs the palette added.
 * @param text - the text to wrap.
 * @param width - the viewport width in columns.
 * @returns the wrapped lines.
 */
function wrap(text: string, width: number): string[] {
  return text.split('\n').flatMap(line => wrapTextWithAnsi(line, width))
}
