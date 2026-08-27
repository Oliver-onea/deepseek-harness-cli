/**
 * The terminal answer surface for `ctx.userQuestions`: a keyboard panel that
 * walks one request's questions in order and resolves the answer the asking
 * tool call is waiting on.
 * @module @deepseek-ai/dsh-tui/questions
 */

import { matchesKey, type Component } from '@earendil-works/pi-tui'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import { displayLine, displayText } from './display-text.ts'
import type { Palette } from './theme.ts'

/** The terminal surface a panel needs to appear on and be redrawn. */
export interface PanelHost {
  /**
   * Show one panel until it settles.
   * @param panel - the component to display.
   * @returns a disposer that removes the panel.
   */
  present(panel: Component): () => void
  /** Ask the renderer to draw again. */
  requestRender(): void
}

/**
 * How many options a number key can reach directly, across the keyboard
 * panels this package draws.
 */
export const DIRECT_SELECT_LIMIT = 9

/** One question's in-progress answer. */
export interface ItemState {
  /** The question's options, resolved once so every reader sees one list. */
  options: readonly AskUserQuestionOption[]
  /** Index of the highlighted option. */
  cursor: number
  /** Labels chosen so far; single-select keeps at most one. */
  chosen: Set<string>
  /** Free-text answer being typed, when the reader switched to it. */
  custom: string
  /** Whether input is going to {@link ItemState.custom} rather than the option list. */
  typing: boolean
}

/**
 * Start state for one question: a question with no options is answered by
 * typing, so it opens in text mode.
 * @param item - the question to open.
 * @returns its initial state.
 */
function openItem(item: AskUserQuestionItem): ItemState {
  const options = item.options ?? []
  return {
    options,
    cursor: 0,
    chosen: new Set(),
    custom: '',
    typing: options.length === 0,
  }
}

/**
 * Settle one question's state into its wire answer. Typed text overrides a
 * single-select choice and supplements a multi-select one, which is what
 * `AskUserQuestionAnswerItem` documents.
 * @param item - the answered question.
 * @param state - the reader's input for it.
 * @returns the answer item to send.
 */
export function settleItem(item: AskUserQuestionItem, state: ItemState): AskUserQuestionAnswerItem {
  const custom = state.custom.trim()
  const options = state.options
  const selected = item.multiSelect === true
    ? options.filter(option => state.chosen.has(option.label)).map(option => option.label)
    : options.filter(option => state.chosen.has(option.label)).slice(0, 1).map(option => option.label)
  if (custom === '') return { id: item.id, selected }
  if (item.multiSelect === true) return { id: item.id, selected, custom }
  return { id: item.id, selected: [], custom }
}

/** The panel that collects one request's answers. */
export class QuestionPanel implements Component {
  private index = 0
  private state: ItemState
  private settled = false
  private readonly answers: AskUserQuestionAnswerItem[] = []

  /**
   * @param items - the questions to walk, in order.
   * @param palette - the styles to draw with.
   * @param onSettle - called once with the complete answer, or `undefined` when the reader aborts.
   * @param onChange - called whenever the drawn content changes.
   */
  constructor(
    private readonly items: readonly AskUserQuestionItem[],
    private readonly palette: Palette,
    private readonly onSettle: (answer: AskUserQuestionAnswer | undefined) => void,
    private readonly onChange: () => void,
  ) {
    this.state = openItem(this.current)
  }

  /** The question currently being answered. */
  private get current(): AskUserQuestionItem {
    // The service rejects an empty request, so an index inside the batch
    // always names a question.
    return this.items[Math.min(this.index, this.items.length - 1)] as AskUserQuestionItem
  }

  /** Nothing is cached between draws. */
  invalidate(): void {}

  /**
   * Draw the current question, its options, and the controls that apply.
   * @param width - the panel width in columns.
   * @returns the panel's lines.
   */
  render(width: number): string[] {
    const item = this.current
    const palette = this.palette
    const lines: string[] = []
    if (this.items.length > 1) {
      lines.push(palette.dim(`Question ${this.index + 1} of ${this.items.length}`))
    }
    if (item.header !== undefined) lines.push(palette.dim(displayLine(item.header)))
    lines.push(palette.bold(displayLine(item.question)))
    if (item.detail !== undefined) {
      for (const line of displayText(item.detail).split('\n')) lines.push(palette.dim(line))
    }
    lines.push(...this.renderOptions(width))
    if (this.state.typing) {
      lines.push(`${palette.tool('>')} ${displayLine(this.state.custom)}${palette.dim('▏')}`)
    }
    lines.push(palette.dim(this.controls()))
    return lines
  }

  /**
   * Draw the option rows, marking the cursor and every chosen label.
   * @param width - the panel width in columns.
   * @returns the option lines.
   */
  private renderOptions(width: number): string[] {
    const options = this.state.options
    const palette = this.palette
    return options.map((option, position) => {
      const chosen = this.state.chosen.has(option.label) ? '●' : '○'
      const number = position < DIRECT_SELECT_LIMIT ? `${position + 1}.` : '  '
      const text = option.description === undefined
        ? displayLine(option.label)
        : `${displayLine(option.label)} — ${displayLine(option.description)}`
      const row = ` ${number} ${chosen} ${text}`.slice(0, width)
      return !this.state.typing && position === this.state.cursor ? palette.selected(row) : row
    })
  }

  /**
   * Name the controls that currently do something: navigation disappears for a
   * single option, and toggling appears only for a multi-select question.
   * @returns the controls hint.
   */
  private controls(): string {
    const item = this.current
    const options = this.state.options
    const hints: string[] = []
    if (options.length > 1 && !this.state.typing) hints.push('↑↓ move')
    if (item.multiSelect === true) hints.push('space toggle')
    if (options.length > 0) hints.push(this.state.typing ? 'tab options' : 'tab type an answer')
    hints.push('enter answer', 'esc cancel')
    return hints.join('  ')
  }

  /**
   * Route one key press.
   * @param data - the raw input sequence.
   */
  handleInput(data: string): void {
    if (this.settled) return
    if (matchesKey(data, 'escape')) {
      this.finish(undefined)
      return
    }
    if (matchesKey(data, 'enter')) {
      this.advance()
      return
    }
    if (matchesKey(data, 'tab')) {
      this.toggleTyping()
      return
    }
    if (this.state.typing) {
      this.type(data)
      return
    }
    this.navigate(data)
  }

  /** Switch between the option list and the free-text answer. */
  private toggleTyping(): void {
    if (this.state.options.length === 0) return
    this.state.typing = !this.state.typing
    this.onChange()
  }

  /**
   * Accumulate one key into the free-text answer.
   * @param data - the raw input sequence.
   */
  private type(data: string): void {
    if (matchesKey(data, 'backspace')) {
      this.state.custom = this.state.custom.slice(0, -1)
      this.onChange()
      return
    }
    // Printable input only: control sequences reaching an answer field would
    // otherwise be pasted into the answer the tool call receives.
    const first = data.codePointAt(0)
    if (first === undefined || first < 0x20 || first === 0x7f) return
    this.state.custom += data
    this.onChange()
  }

  /**
   * Move the cursor or choose an option.
   * @param data - the raw input sequence.
   */
  private navigate(data: string): void {
    const options = this.state.options
    if (matchesKey(data, 'up')) {
      this.state.cursor = (this.state.cursor + options.length - 1) % options.length
      this.onChange()
      return
    }
    if (matchesKey(data, 'down')) {
      this.state.cursor = (this.state.cursor + 1) % options.length
      this.onChange()
      return
    }
    if (matchesKey(data, 'space')) {
      this.choose(this.state.cursor)
      return
    }
    const digit = Number.parseInt(data, 10)
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(options.length, DIRECT_SELECT_LIMIT)) {
      this.state.cursor = digit - 1
      this.choose(digit - 1)
    }
  }

  /**
   * Choose one option, replacing the previous choice unless the question is
   * multi-select.
   * @param position - the option's index.
   */
  private choose(position: number): void {
    const option = this.state.options[position]
    /* v8 ignore next -- callers pass an index inside the current option list */
    if (option === undefined) return
    if (this.current.multiSelect !== true) this.state.chosen.clear()
    if (this.state.chosen.has(option.label)) this.state.chosen.delete(option.label)
    else this.state.chosen.add(option.label)
    this.onChange()
  }

  /** Record the current question's answer and move to the next, or settle. */
  private advance(): void {
    const item = this.current
    // Enter on an untouched option list takes the highlighted row, which is
    // what a reader who just pressed Enter meant by it.
    if (!this.state.typing && this.state.chosen.size === 0) this.choose(this.state.cursor)
    this.answers.push(settleItem(item, this.state))
    if (this.index === this.items.length - 1) {
      this.finish({ answers: this.answers })
      return
    }
    this.index += 1
    this.state = openItem(this.current)
    this.onChange()
  }

  /**
   * Settle the batch exactly once.
   * @param answer - the collected answers, or `undefined` when aborted.
   */
  private finish(answer: AskUserQuestionAnswer | undefined): void {
    this.settled = true
    this.onSettle(answer)
  }
}

/** The `ctx.userQuestions` provider backed by {@link QuestionPanel}. */
export class TerminalQuestions implements UserQuestionProvider {
  /**
   * @param host - the terminal surface panels appear on.
   * @param palette - the styles panels draw with.
   */
  constructor(
    private readonly host: PanelHost,
    private readonly palette: Palette,
  ) {}

  /**
   * Ask the reader and wait for the answer.
   * @param request - the questions to put, with the asking step's abort signal.
   * @returns the reader's answers.
   */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      // Assigned below, before any key can reach the panel; a signal that is
      // already aborted settles before the panel is even shown.
      // eslint-disable-next-line prefer-const -- `settle` closes over it, so the assignment below is a later write.
      let close: (() => void) | undefined
      const settle = (answer: AskUserQuestionAnswer | undefined): void => {
        close?.()
        if (answer === undefined) reject(new Error('the user dismissed the question'))
        else resolve(answer)
      }
      const panel = new QuestionPanel(request.questions, this.palette, settle, () => {
        this.host.requestRender()
      })
      close = this.host.present(panel)
      // A withdrawn ask (the step was cancelled) takes the panel down with it,
      // so a stale question cannot keep owning the keyboard.
      request.signal?.addEventListener('abort', () => { settle(undefined) }, { once: true })
    })
  }
}
