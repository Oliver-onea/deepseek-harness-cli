/**
 * The launch-time resume picker: a keyboard list drawn on the ordinary
 * terminal before any session exists, so a reader can continue a persisted
 * session without knowing its id. It runs ahead of the alternate-screen front
 * door and owns stdin only while a list is on screen; every row passes
 * {@link displayLine}, because persisted metadata is untrusted text.
 * @module @deepseek-ai/dsh-tui/resume-picker
 */

import { homedir } from 'node:os'
import { sep } from 'node:path'
import { matchesKey } from '@earendil-works/pi-tui'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { displayLine } from './display-text.ts'
import { DIRECT_SELECT_LIMIT } from './questions.ts'
import { createPalette } from './theme.ts'

/** One persisted session the launch picker offers. */
export interface ResumeCandidate {
  /** The session id `--resume` consumes. */
  readonly id: SessionId
  /** Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in, when recorded. */
  readonly cwd: string | undefined
}

/**
 * Derive the picker's roster from persisted headers: subagent children are
 * delegation scratchpads rather than conversations a reader resumes, and the
 * newest session comes first because it is the likeliest resume target. The
 * id breaks creation-time ties so the order stays deterministic.
 * @param headers - every materialized session a store listed.
 * @returns top-level candidates, newest first.
 */
export function resumeCandidates(headers: readonly SessionHeader[]): ResumeCandidate[] {
  return headers
    .filter(header => header.origin !== 'subagent')
    .map(header => ({ id: header.id, createdAt: header.createdAt, cwd: header.cwd }))
    .sort((left, right) => right.createdAt - left.createdAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** How one launch-picker run settled. */
export type ResumePickerOutcome =
  | { kind: 'picked'; candidate: ResumeCandidate }
  /** The reader dismissed the list, or the caller aborted it: nothing starts. */
  | { kind: 'dismissed' }
  /** The terminal had no room for a candidate row: nothing rendered or captured keys. */
  | { kind: 'too-small' }

/**
 * The TTY stdin the picker reads keys from; the caller has already verified
 * it is a TTY.
 */
export interface PickerStdin {
  /** Switch the stream between raw key delivery and line mode. */
  setRawMode(mode: boolean): unknown
  /** Begin delivering chunks. */
  resume(): unknown
  /** Stop delivering chunks. */
  pause(): unknown
  /** Observe key chunks. */
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
  /** Stop observing key chunks. */
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown
  /** Observe the stream's final close. */
  once(event: 'close', listener: () => void): unknown
  /** Stop observing the stream's final close. */
  off(event: 'close', listener: () => void): unknown
}

/** The TTY stdout the picker draws its list on. */
export interface PickerStdout {
  /** Terminal rows, when the stream reports its geometry. */
  readonly rows?: number | undefined
  /** Terminal columns, when the stream reports its geometry. */
  readonly columns?: number | undefined
  /** Draw text on the ordinary screen. */
  write(chunk: string): unknown
}

/** Everything the launch picker reads. */
export interface ResumePickerOptions {
  /** Non-empty candidate roster, newest first ({@link resumeCandidates} output). */
  readonly candidates: readonly ResumeCandidate[]
  /** Whether to style rows; `false` renders the same layout without SGR sequences. */
  readonly color: boolean
  /** The TTY stdin keys arrive on. */
  readonly stdin: PickerStdin
  /** The TTY stdout the list is drawn on. */
  readonly stdout: PickerStdout
  /** Cancellation; aborting settles the picker dismissed and restores line mode. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Rows the ordinary screen owes to everything that is not a candidate row:
 * the invocation's own prompt line, the picker's title and blank separator,
 * its controls hint, and the scroll indicator whenever the roster overflows.
 */
export const PICKER_RESERVED_ROWS = 5

/**
 * Bound the picker to the candidate rows a terminal leaves free. A terminal
 * with no room for one candidate row gets no list at all — nothing renders
 * and no key is captured — matching the row gate the in-screen pickers
 * degrade through.
 * @param rows - current terminal rows.
 * @returns candidate rows the picker may draw, zero for none.
 */
export function pickerRowsFor(rows: number): number {
  return Math.max(0, rows - PICKER_RESERVED_ROWS - 1)
}

/** Columns of a session id one row keeps before truncating. */
const ID_COLUMNS = 16

/**
 * Render a creation timestamp as local `YYYY-MM-DD HH:mm`, the resolution a
 * reader picks a session by.
 * @param createdAt - Unix epoch milliseconds when the session was created.
 * @returns the row's timestamp text.
 */
function stamp(createdAt: number): string {
  const time = new Date(createdAt)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} `
    + `${two(time.getHours())}:${two(time.getMinutes())}`
}

/**
 * Collapse the reader's home directory prefix to `~` so row paths stay short.
 * @param path - the absolute working directory a session was created in.
 * @returns the path with its home prefix collapsed.
 */
export function collapseHome(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
}

/**
 * Build one candidate row's text: creation time, home-collapsed workspace,
 * and a truncated session id — every segment sanitized, because persisted
 * metadata is untrusted.
 * @param candidate - the session this row offers.
 * @returns the row's text without its number or cursor marker.
 */
function rowBody(candidate: ResumeCandidate): string {
  const where = candidate.cwd === undefined ? '' : `  ${displayLine(collapseHome(candidate.cwd))}`
  const id = displayLine(candidate.id)
  const short = id.length > ID_COLUMNS ? `${id.slice(0, ID_COLUMNS)}…` : id
  return `${stamp(candidate.createdAt)}${where}  ${short}`
}

/**
 * Run the launch picker on the ordinary terminal: `↑`/`↓` move, a number
 * picks that row directly, `enter` resumes the cursor row, and `esc` and
 * `ctrl+c` both exit without resuming or creating anything — at launch there
 * is no queued work to lose, and a picker abandoned by either key must not
 * substitute a fresh session for the resume the invocation asked for. The
 * list redraws in place and is erased when the picker settles; stdin returns
 * to line mode so the front door that follows starts from a clean terminal.
 * @param options - the roster, styling, streams, and cancellation.
 * @returns how the run settled.
 */
export function pickResumeSession(options: ResumePickerOptions): Promise<ResumePickerOutcome> {
  if (options.signal?.aborted) return Promise.resolve({ kind: 'dismissed' })
  const height = Math.min(pickerRowsFor(options.stdout.rows ?? 0), options.candidates.length)
  if (height <= 0) return Promise.resolve({ kind: 'too-small' })
  return new Promise<ResumePickerOutcome>((resolve) => {
    const palette = createPalette(options.color)
    const candidates = options.candidates
    const width = options.stdout.columns ?? 80
    let cursor = 0
    let drawn = 0
    let closed = false
    let settled = false

    const rows = (): string[] => {
      const first = Math.min(Math.max(0, cursor - height + 1), candidates.length - height)
      const shown = candidates.slice(first, first + height)
      const lines: string[] = [palette.bold('Resume a session'), '']
      for (const [position, candidate] of shown.entries()) {
        const index = first + position
        const number = index < DIRECT_SELECT_LIMIT ? `${index + 1}.` : '  '
        const row = `${index === cursor ? '>' : ' '} ${number} ${rowBody(candidate)}`.slice(0, width)
        lines.push(index === cursor ? palette.selected(row) : row)
      }
      const hidden = candidates.length - shown.length
      if (hidden > 0) lines.push(palette.dim(`… ${hidden} more`))
      lines.push(palette.dim('↑↓ or a number moves  enter resumes  esc/ctrl+c exits without starting'))
      return lines
    }

    const draw = (): void => {
      const lines = rows()
      // Redraw in place: return to the top of the drawn block and erase
      // downward, so the list owns exactly the rows it drew.
      const redraw = drawn > 0 ? `\x1b[${drawn}A\x1b[J` : ''
      drawn = lines.length
      options.stdout.write(`${redraw}${lines.join('\n')}\n`)
    }

    const onAbort = (): void => { finish({ kind: 'dismissed' }) }
    const onClose = (): void => {
      closed = true
      finish({ kind: 'dismissed' })
    }

    function finish(outcome: ResumePickerOutcome): void {
      if (settled) return
      settled = true
      options.stdin.off('data', onData)
      options.stdin.off('close', onClose)
      options.signal?.removeEventListener('abort', onAbort)
      if (!closed) {
        options.stdin.setRawMode(false)
        options.stdin.pause()
      }
      const erase = `\x1b[${drawn}A\x1b[J`
      options.stdout.write(outcome.kind === 'picked'
        ? `${erase}${palette.dim(`resuming ${outcome.candidate.id}`)}\n`
        : erase)
      resolve(outcome)
    }

    function onData(chunk: string | Buffer): void {
      if (settled) return
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (candidates.length > 1 && matchesKey(data, 'up')) {
        cursor = (cursor + candidates.length - 1) % candidates.length
        draw()
        return
      }
      if (candidates.length > 1 && matchesKey(data, 'down')) {
        cursor = (cursor + 1) % candidates.length
        draw()
        return
      }
      if (matchesKey(data, 'enter')) {
        finish({ kind: 'picked', candidate: candidates[cursor] as ResumeCandidate })
        return
      }
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
        finish({ kind: 'dismissed' })
        return
      }
      const digit = Number.parseInt(data, 10)
      if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(candidates.length, DIRECT_SELECT_LIMIT)) {
        finish({ kind: 'picked', candidate: candidates[digit - 1] as ResumeCandidate })
      }
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    options.stdin.on('data', onData)
    options.stdin.once('close', onClose)
    options.stdin.setRawMode(true)
    options.stdin.resume()
    draw()
  })
}
