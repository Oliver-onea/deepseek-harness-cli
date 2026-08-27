/**
 * Tool cards: the terminal projection of a tool's own render intent. Every
 * shape here comes from `presentCall`/`presentResult`, so a tool changes how
 * it reads in the terminal by changing its presenter, never by adding a
 * branch to this renderer. A card opens with the call line and, once settled,
 * attaches the result beneath it on an elbow with a dimmed body — no border
 * surrounds the card.
 * @module @deepseek-ai/dsh-tui/tool-card
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { displayLine, displayText } from './display-text.ts'
import type { Palette } from './theme.ts'
import type { ToolOutcome } from './transcript.ts'

/** Everything one card draws from. */
export interface ToolCard {
  /** The registered tool name, the fallback title when the tool presents none. */
  name: string
  /** The raw arguments JSON exactly as the model produced it. */
  rawArguments: string
  /** The tool's pending-call view, when it declared one. */
  call: ToolCallView | undefined
  /** The tool's completed view, when it declared one. */
  result: ToolResultView | undefined
  /** The model-facing outcome; absent while the call runs. */
  outcome: ToolOutcome | undefined
}

/** How much of a card body to draw. */
export interface CardLayout {
  /** Lines kept at the head of a folded body. */
  headLines: number
  /** Lines kept at the tail of a folded body. */
  tailLines: number
  /** Whether the reader expanded every card. */
  expanded: boolean
}

/** Glyph marking a card's run state. */
const RUNNING = '·'
const SUCCEEDED = '✓'
const FAILED = '✗'

/** Glyph attaching a settled result to its call line. */
const ELBOW = '╰'

/** Argument fields a card header names, most identifying first. */
const SHORT_ARG_KEYS = ['command', 'file_path', 'pattern', 'path', 'query', 'url', 'objective'] as const

/** Maximum visible length of the argument a card header names. */
const MAX_SHORT_ARG_LENGTH = 40

/**
 * Summarize a call's arguments for the header of a tool that presents no
 * title of its own: one identifying string value, so an MCP or otherwise
 * unpresented call still reads as `name(args)` rather than a bare name.
 * @param rawArguments - the raw arguments JSON the model produced.
 * @returns ` (value)` truncated and sanitized, or `` when nothing identifies.
 */
export function shortArgs(rawArguments: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const record = parsed as Record<string, unknown>
  let value: unknown
  for (const key of SHORT_ARG_KEYS) {
    if (typeof record[key] === 'string') {
      value = record[key]
      break
    }
  }
  if (value === undefined) value = Object.values(record).find(candidate => typeof candidate === 'string')
  if (typeof value !== 'string' || value === '') return ''
  const line = displayLine(value)
  const short = line.length > MAX_SHORT_ARG_LENGTH ? `${line.slice(0, MAX_SHORT_ARG_LENGTH)}…` : line
  return ` (${short})`
}

/**
 * Join a view's content blocks into terminal text.
 * @param content - the blocks a view carried, when any.
 * @returns the joined, normalized text.
 */
function blockText(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  let joined = ''
  for (const block of content) {
    if (block.type === 'text') joined += block.text
  }
  return displayText(joined)
}

/**
 * Split body text into drawable lines, dropping a single trailing blank line so
 * a body ending in a newline does not push a gap into the card.
 * @param text - the body text.
 * @returns the body's lines.
 */
function bodyLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Fold a long body to its head and tail, naming how many lines are hidden.
 * @param lines - the body's complete lines.
 * @param layout - the reader's current fold settings.
 * @param palette - the styles for the hidden-line count.
 * @returns the lines to draw.
 */
function fold(lines: readonly string[], layout: CardLayout, palette: Palette): string[] {
  const budget = layout.headLines + layout.tailLines
  if (layout.expanded || lines.length <= budget + 1) return [...lines]
  const hidden = lines.length - budget
  return [
    ...lines.slice(0, layout.headLines),
    palette.dim(`… ${hidden} more lines`),
    ...lines.slice(lines.length - layout.tailLines),
  ]
}

/**
 * The call line's title: the pending view's own title, else the registered
 * name with one identifying argument, so an unpresented call still reads as
 * `name(args)`.
 * @param card - the card's views and identity.
 * @returns the single-line call title.
 */
function callTitle(card: ToolCard): string {
  if (card.call !== undefined) return displayLine(card.call.title)
  return `${card.name}${shortArgs(card.rawArguments)}`
}

/**
 * The settled result's title for the elbow line, when it names something the
 * call line does not already say.
 * @param card - the card's views.
 * @returns the result title, or `undefined` when it adds nothing.
 */
function elbowTitle(card: ToolCard): string | undefined {
  const title = card.result?.title
  if (title === undefined) return undefined
  const line = displayLine(title)
  if (card.call !== undefined && line === displayLine(card.call.title)) {
    return undefined
  }
  return line
}

/**
 * The run-state glyph and its style.
 * @param card - the card's outcome, when settled.
 * @param palette - the styles to pick from.
 * @returns the styled glyph.
 */
function glyph(card: ToolCard, palette: Palette): string {
  if (card.outcome === undefined) return palette.dim(RUNNING)
  return card.outcome.isError ? palette.error(FAILED) : palette.success(SUCCEEDED)
}

/**
 * Draw one diff hunk with its file header.
 * @param diffs - the view's per-file changes.
 * @param palette - the styles for added and removed lines.
 * @returns the drawn lines.
 */
function diffLines(
  diffs: readonly { path: string; oldText: string | null; newText: string }[],
  palette: Palette,
): string[] {
  const lines: string[] = []
  for (const diff of diffs) {
    lines.push(palette.dim(displayLine(diff.path)))
    if (diff.oldText !== null) {
      for (const line of bodyLines(displayText(diff.oldText))) lines.push(palette.error(`- ${line}`))
    }
    for (const line of bodyLines(displayText(diff.newText))) lines.push(palette.success(`+ ${line}`))
  }
  return lines
}

/**
 * Draw the body of a completed call from the tool's own result view, falling
 * back to the model-facing result text for a view this renderer has no shape
 * for and for a tool that presented none.
 * @param card - the card's views and outcome.
 * @param palette - the styles the body uses.
 * @returns the body lines before folding.
 */
function resultBody(card: ToolCard, palette: Palette): string[] {
  const view = card.result
  if (view === undefined) return bodyLines(blockText(card.outcome?.content))
  switch (view.card) {
    case 'terminal':
      return bodyLines(displayText(view.output ?? ''))
    case 'diff':
      return diffLines(view.diffs, palette)
    case 'read':
      return view.lines.map(line => `${palette.dim(String(line.number).padStart(5))} ${displayLine(line.text)}`)
    case 'search':
      return view.shape === 'paths'
        ? view.paths.map(path => displayLine(path))
        : view.files.flatMap(file => [
          palette.dim(displayLine(file.path)),
          ...file.matches.map(match => `${palette.dim(String(match.lineNumber).padStart(5))} ${displayLine(match.line)}`),
        ])
    case 'web':
      return view.kind === 'fetch'
        ? [palette.dim(`${view.statusCode} ${displayLine(view.url)}`)]
        : view.sources.map(source => palette.dim(displayLine(source.title ?? source.url)))
    case 'generic':
      return bodyLines(blockText(view.content ?? card.outcome?.content))
    // The view union is merge-extensible: an unrecognized card still has the
    // model-facing result to show, which is what an incapable UI falls back to.
    default:
      return bodyLines(blockText(card.outcome?.content))
  }
}

/**
 * Draw the body of a pending call: what the tool says it is about to do.
 * @param call - the pending-call view.
 * @param palette - the styles the body uses.
 * @returns the body lines before folding.
 */
function callBody(call: ToolCallView, palette: Palette): string[] {
  switch (call.card) {
    case 'terminal':
      return call.description === undefined ? [] : [palette.dim(displayLine(call.description))]
    case 'diff':
      return diffLines(call.diffs, palette)
    case 'generic':
      return bodyLines(blockText(call.content))
    // Merge-extensible union: an unrecognized pending card draws its title only.
    default:
      return []
  }
}

/**
 * Render one tool card: the call line, then — once the call settles — the
 * result attached with an elbow so it reads as belonging to its call without
 * a box around either. A settled result keeps the call's line as the header
 * and names the result beneath it; an error colors the elbow line.
 * @param card - the call, its views, and its outcome.
 * @param palette - the styles to draw with.
 * @param layout - the reader's current fold settings.
 * @returns the card's lines, header first.
 */
export function renderToolCard(card: ToolCard, palette: Palette, layout: CardLayout): string[] {
  const header = `${glyph(card, palette)} ${palette.tool(callTitle(card))}`
  if (card.outcome === undefined) {
    const body = card.call === undefined ? [] : callBody(card.call, palette)
    return [header, ...fold(body, layout, palette).map(line => `  ${line}`)]
  }
  const lines = [header]
  const elbow = elbowTitle(card)
  if (elbow !== undefined) {
    const style = card.outcome.isError ? palette.error : palette.dim
    lines.push(`${ELBOW} ${style(elbow)}`)
  }
  const body = resultBody(card, palette).map(line => palette.dim(line))
  lines.push(...fold(body, layout, palette).map(line => `  ${line}`))
  return lines
}
