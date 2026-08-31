/**
 * The transcript component: the {@link Transcript} fold drawn as terminal
 * lines. Rendered lines are cached per entry and invalidated by content or
 * width change, so redrawing a long conversation costs the entries that
 * actually moved rather than the whole history.
 * @module @deepseek-ai/dsh-tui/view
 */

import { getCapabilities, Image, Markdown, wrapTextWithAnsi, type Component, type MarkdownTheme } from '@earendil-works/pi-tui'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { renderToolCard, type CardLayout } from './tool-card.ts'
import type { Palette } from './theme.ts'
import { highlightCode } from './highlight.ts'
import type { ImageEntry, ToolEntry, ToolOutcome, Transcript, TranscriptEntry } from './transcript.ts'

/**
 * Reads a durable image's encoded bytes for inline rendering. Implemented by
 * an adapter over `ctx.attachments`; its absence means every image draws its
 * text fallback without attempting a read.
 */
export interface AttachmentImageReader {
  /**
   * Read one durable image's bytes.
   * @param ref - the durable reference the transcript entry carries.
   * @param signal - cancellation for the read, honored while it is in flight.
   * @returns the raw encoded bytes.
   */
  read(ref: ImageAttachmentRef, signal: AbortSignal): Promise<Uint8Array>
}

/** How the view resolves and bounds inline images. */
export interface ImageViewOptions {
  /** Reads image bytes for a capable terminal; absent renders text fallbacks only. */
  reader: AttachmentImageReader | undefined
  /** Maximum inline image width in terminal cells. */
  maxWidthCells: number
  /** Maximum inline image height in terminal cells; unset keeps the image's own aspect ratio. */
  maxHeightCells: number | undefined
  /** Ask the host to redraw once a background image fetch settles. */
  requestRender: () => void
}

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
  /** How to resolve and bound inline images. */
  images: ImageViewOptions
}

/** One image entry's rendering state, kept across renders and width changes. */
interface ImageState {
  /** The pi-tui component this entry currently draws through. */
  component: Image
  /** Whether a load attempt has finished (successfully or not); a settled
   * entry never triggers a second read. */
  settled: boolean
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
  private readonly images = new WeakMap<ImageEntry, ImageState>()
  private readonly pendingReads = new Set<AbortController>()
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
   * Cancel every in-flight image read. Called when the owning shell tears
   * down, so a torn-down screen never resolves into a view nothing draws.
   */
  dispose(): void {
    for (const controller of this.pendingReads) controller.abort()
    this.pendingReads.clear()
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
    const revision = this.revisionOf(entry)
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
   * A content fingerprint for one entry, cheap enough to compute every
   * render. An image's fingerprint changes once its background read settles,
   * so a fallback line drawn before the bytes arrived is not reused after.
   * @param entry - the transcript entry.
   * @returns a string that changes whenever the drawn content would.
   */
  private revisionOf(entry: TranscriptEntry): string {
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
      case 'image':
        return `${entry.ref.attachmentId}:${String(this.images.get(entry)?.settled ?? false)}`
      // An entry kind this module cannot draw gets a constant fingerprint here
      // and is refused by `drawEntry`, the single guard for the closed union.
      default:
        return ''
    }
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
      case 'image':
        return this.drawImage(entry, width)
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
   * Build the pi-tui image component for one entry's current bytes, or its
   * text-fallback placeholder while none have loaded yet.
   * @param entry - the image entry to build for.
   * @param data - the loaded bytes, or `undefined` before a read settles.
   * @returns the component `drawImage` renders through.
   */
  private buildImage(entry: ImageEntry, data: Uint8Array | undefined): Image {
    const ref = entry.ref
    const images = this.options.images
    return new Image(
      data === undefined ? '' : Buffer.from(data).toString('base64'),
      ref.mediaType,
      { fallbackColor: this.options.palette.dim },
      {
        maxWidthCells: images.maxWidthCells,
        ...images.maxHeightCells === undefined ? {} : { maxHeightCells: images.maxHeightCells },
        ...ref.name === undefined ? {} : { filename: ref.name },
      },
      { widthPx: ref.width, heightPx: ref.height },
    )
  }

  /**
   * Draw one inline image, resolving its component lazily and dispatching a
   * background byte read the first time a capable terminal draws it.
   * @param entry - the image entry to draw.
   * @param width - the viewport width in columns.
   * @returns the image's lines: the placed graphic, or its text fallback.
   */
  private drawImage(entry: ImageEntry, width: number): string[] {
    let state = this.images.get(entry)
    if (state === undefined) {
      state = { component: this.buildImage(entry, undefined), settled: false }
      this.images.set(entry, state)
      this.loadImage(entry, state)
    }
    return state.component.render(width)
  }

  /**
   * Dispatch the one background read an image entry ever gets. A terminal
   * with no image protocol, or a composition with no attachment reader, never
   * reaches the store: the fallback already drew from the entry's own
   * metadata, so no bytes are needed.
   * @param entry - the image entry to load.
   * @param state - its rendering state, mutated once the read settles.
   */
  private loadImage(entry: ImageEntry, state: ImageState): void {
    const images = this.options.images
    if (images.reader === undefined || getCapabilities().images === null) {
      state.settled = true
      return
    }
    const controller = new AbortController()
    this.pendingReads.add(controller)
    images.reader.read(entry.ref, controller.signal)
      .then((data) => {
        state.component = this.buildImage(entry, data)
        state.settled = true
        images.requestRender()
      })
      // A failed or cancelled read keeps the text fallback the component
      // already renders from the entry's own metadata; nothing else can
      // observe a background read, so there is nothing further to report.
      .catch(() => { state.settled = true })
      .finally(() => { this.pendingReads.delete(controller) })
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
