/** The launch-time resume picker: roster derivation, row layout, keys, and degradation. */

import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  PICKER_RESERVED_ROWS,
  pickResumeSession,
  pickerRowsFor,
  resumeCandidates,
  type PickerStdin,
  type PickerStdout,
  type ResumeCandidate,
  type ResumePickerOutcome,
} from '../src/resume-picker.ts'

const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

const HINT = '↑↓ or a number moves  enter resumes  esc/ctrl+c exits without starting'

/** A local-anchored timestamp, so the rendered stamp is timezone-independent. */
function at(...parts: [number, number, number, number, number]): number {
  return new Date(...parts).getTime()
}

/** One candidate with stable defaults. */
function candidate(over: Partial<ResumeCandidate> = {}): ResumeCandidate {
  return {
    id: SessionId('session-00000000-0000-4000-8000-000000000001'),
    createdAt: at(2026, 7, 16, 12, 3),
    cwd: '/work',
    ...over,
  }
}

/** One persisted header with stable defaults. */
function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 0,
    id: SessionId('session-00000000-0000-4000-8000-000000000001'),
    createdAt: at(2026, 7, 16, 12, 3),
    cwd: '/work',
    ...over,
  }
}

/** The stdin fake: buffered pushes reach the picker whenever it subscribes. */
class FakeStdin implements PickerStdin {
  readonly rawModes: boolean[] = []
  resumed = false
  paused = false
  private readonly pending: (string | Buffer)[] = []
  private readonly dataListeners = new Set<(chunk: string | Buffer) => void>()
  private readonly closeListeners = new Set<() => void>()

  on(_event: 'data', listener: (chunk: string | Buffer) => void): void {
    this.dataListeners.add(listener)
    for (const chunk of this.pending.splice(0)) listener(chunk)
  }

  off(event: 'data' | 'close', listener: ((chunk: string | Buffer) => void) & (() => void)): void {
    if (event === 'data') this.dataListeners.delete(listener)
    else this.closeListeners.delete(listener)
  }

  once(_event: 'close', listener: () => void): void {
    this.closeListeners.add(listener)
  }


  setRawMode(mode: boolean): void {
    this.rawModes.push(mode)
  }

  resume(): void {
    this.resumed = true
  }

  pause(): void {
    this.paused = true
  }

  /** Deliver one key chunk, buffering it before any listener exists. */
  push(chunk: string | Buffer): void {
    if (this.dataListeners.size === 0) {
      this.pending.push(chunk)
      return
    }
    for (const listener of [...this.dataListeners]) listener(chunk)
  }

  /** Close the stream under the picker. */
  close(): void {
    for (const listener of [...this.closeListeners]) listener()
  }

  /** How many key listeners remain attached. */
  get listeners(): number {
    return this.dataListeners.size
  }
}

/** The stdout fake: records every chunk the picker drew. */
class FakeStdout implements PickerStdout {
  readonly chunks: string[] = []
  constructor(readonly rows?: number, readonly columns?: number) {}

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  /** Everything drawn so far. */
  get text(): string {
    return this.chunks.join('')
  }
}

/** Run one picker over fakes and settle it with `drive`. */
async function run(
  options: { candidates?: ResumeCandidate[]; color?: boolean; rows?: number; columns?: number },
  drive: (stdin: FakeStdin) => void = () => {},
  signal?: AbortSignal,
): Promise<{ outcome: ResumePickerOutcome; stdin: FakeStdin; stdout: FakeStdout }> {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout(options.rows ?? 30, options.columns ?? 100)
  const pending = pickResumeSession({
    candidates: options.candidates ?? [candidate()],
    color: options.color ?? false,
    stdin,
    stdout,
    ...signal === undefined ? {} : { signal },
  })
  // Buffered pushes reach the picker whenever it subscribes, so settling
  // keys may be queued before the picker drew.
  drive(stdin)
  const outcome = await pending
  return { outcome, stdin, stdout }
}

describe('resumeCandidates', () => {
  it('offers top-level sessions newest first', () => {
    const older = header({ id: SessionId('session-a'), createdAt: at(2026, 7, 1, 9, 0) })
    const newer = header({ id: SessionId('session-b'), createdAt: at(2026, 7, 16, 12, 3) })
    expect(resumeCandidates([older, newer]).map(entry => entry.id)).toEqual(['session-b', 'session-a'])
  })

  it('drops subagent children and breaks creation-time ties by id', () => {
    const child = header({ id: SessionId('session-z'), origin: 'subagent', delegationDepth: 1 })
    const tied = header({ id: SessionId('session-b'), createdAt: at(2026, 7, 16, 12, 3) })
    const tiedEarlier = header({ id: SessionId('session-a'), createdAt: at(2026, 7, 16, 12, 3) })
    expect(resumeCandidates([child, tied, tiedEarlier]).map(entry => entry.id)).toEqual(['session-a', 'session-b'])
  })
})

describe('pickerRowsFor', () => {
  it('yields no rows on a 20x5 terminal and the free rows on larger ones', () => {
    expect(pickerRowsFor(5)).toBe(0)
    expect(pickerRowsFor(PICKER_RESERVED_ROWS + 1)).toBe(0)
    expect(pickerRowsFor(PICKER_RESERVED_ROWS + 2)).toBe(1)
    expect(pickerRowsFor(30)).toBe(24)
  })
})

describe('pickResumeSession', () => {
  it('draws the roster and picks the cursor row on enter', async () => {
    const first = candidate()
    const second = candidate({
      id: SessionId('session-00000000-0000-4000-8000-000000000002'),
      createdAt: at(2026, 7, 15, 8, 30),
      cwd: undefined,
    })
    const { outcome, stdin, stdout } = await run({ candidates: [first, second] }, (input) => { input.push(ENTER) })
    expect(outcome).toEqual({ kind: 'picked', candidate: first })
    const [drawn] = stdout.chunks
    expect(drawn).toContain('Resume a session\n\n')
    expect(drawn).toContain('> 1. 2026-08-16 12:03  /work  session-00000000…\n')
    expect(drawn).toContain('  2. 2026-08-15 08:30  session-00000000…\n')
    expect(drawn).toContain(HINT)
    // Cooked mode returns, and the picked session is named before the screen takes over.
    expect(stdin.rawModes).toEqual([true, false])
    expect(stdin.paused).toBe(true)
    expect(stdout.chunks.at(-1)).toContain(`\x1b[${drawn!.split('\n').length - 1}A\x1b[J`)
    expect(stdout.chunks.at(-1)).toContain('resuming session-00000000-0000-4000-8000-000000000001')
  })

  it('moves the cursor with wrapping and redraws the block in place', async () => {
    const candidates = [1, 2, 3].map(index => candidate({
      id: SessionId(`session-${index}`),
      createdAt: at(2026, 7, 16, 12 - index, 3),
    }))
    const { outcome, stdout } = await run({ candidates }, (input) => {
      input.push(DOWN)
      input.push(DOWN)
      input.push(UP)
      input.push(UP)
      input.push(UP)
      input.push(ENTER)
    })
    // Two downs to the end, two ups back, and the third up wraps around.
    expect(outcome).toEqual({ kind: 'picked', candidate: candidates[2] })
    // Every redraw returns to the block top and erases downward.
    for (const chunk of stdout.chunks.slice(1, -1)) {
      expect(chunk).toMatch(/^\x1b\[\d+A\x1b\[J/u)
    }
  })

  it('picks a row by its number directly', async () => {
    const second = candidate({
      id: SessionId('session-2'),
      createdAt: at(2026, 7, 15, 8, 30),
    })
    const { outcome } = await run({ candidates: [candidate(), second] }, (input) => { input.push('2') })
    expect(outcome).toEqual({ kind: 'picked', candidate: second })
  })

  it('exits without resuming on esc and on ctrl+c', async () => {
    for (const key of [ESC, CTRL_C]) {
      const { outcome, stdin } = await run({}, (input) => { input.push(key) })
      expect(outcome).toEqual({ kind: 'dismissed' })
      expect(stdin.rawModes).toEqual([true, false])
    }
  })

  it('ignores keys that name no row', async () => {
    const { outcome, stdout } = await run({}, (input) => {
      input.push('0')
      input.push('9')
      input.push('x')
      input.push('\x1b[Z')
      input.push(Buffer.from('10'))
      input.push(ENTER)
    })
    expect(outcome).toEqual({ kind: 'picked', candidate: candidate() })
    expect(stdout.chunks).toHaveLength(2)
  })

  it('scrolls the window and names the hidden rows', async () => {
    const candidates = [0, 1, 2, 3, 4].map(index => candidate({
      id: SessionId(`session-${index}`),
      createdAt: at(2026, 7, 16, 12, index),
    }))
    const { outcome, stdout } = await run({ candidates, rows: 9 }, (input) => {
      input.push(DOWN)
      input.push(DOWN)
      input.push(DOWN)
      input.push(ENTER)
    })
    expect(outcome).toEqual({ kind: 'picked', candidate: candidates[3] })
    expect(stdout.chunks[0]).toContain('… 2 more')
    // Three downs scroll the window down one row: the fourth candidate draws
    // under the cursor while the count of hidden rows stays the same.
    expect(stdout.chunks[3]).toContain('> 4.')
    expect(stdout.chunks[3]).toContain('… 2 more')
  })

  it('renders nothing and captures no keys below the row gate', async () => {
    const { outcome, stdin, stdout } = await run({ rows: 5, columns: 20 }, (input) => { input.push(ENTER) })
    expect(outcome).toEqual({ kind: 'too-small' })
    expect(stdout.chunks).toEqual([])
    expect(stdin.rawModes).toEqual([])
    expect(stdin.listeners).toBe(0)
  })

  it('renders the same layout without SGR when color is off', async () => {
    const plain = await run({ color: false }, (input) => { input.push(ENTER) })
    const styled = await run({ color: true }, (input) => { input.push(ENTER) })
    expect(plain.stdout.chunks[0]).not.toMatch(/\x1b\[\d+m/u)
    expect(styled.stdout.chunks[0]).toMatch(/\x1b\[\d+m/u)
    expect(styled.stdout.chunks[0]!.replaceAll(/\x1b\[\d+m/gu, '')).toBe(plain.stdout.chunks[0])
    // The cursor row stays visible without styling: the marker is layout.
    expect(plain.stdout.chunks[0]).toContain('> 1.')
  })

  it('sanitizes untrusted metadata to visible escapes', async () => {
    const { stdout } = await run({
      candidates: [candidate({ cwd: join(homedir(), 'pro\x1b]0;pwned\x07\tject') })],
      color: false,
    }, (input) => { input.push(ENTER) })
    expect(stdout.chunks[0]).toContain('\\x1b]0;pwned\\x07')
    expect(stdout.chunks[0]).toContain('\\x1b')
    expect(stdout.chunks[0]).not.toContain('\x1b]0;')
  })

  it('collapses the home prefix and keeps other paths absolute', async () => {
    const inside = candidate({ cwd: join(homedir(), 'codes', 'dsh') })
    const outside = candidate({ cwd: sep === '/' ? '/opt/work' : 'X:\\opt\\work' })
    const { stdout } = await run({ candidates: [inside, outside] }, (input) => { input.push(ENTER) })
    expect(stdout.chunks[0]).toContain('~/codes/dsh')
    expect(stdout.chunks[0]).toContain(sep === '/' ? '/opt/work' : 'X:\\opt\\work')
  })

  it('truncates long ids and rows to the terminal width', async () => {
    const wide = await run({ candidates: [candidate()] }, (input) => { input.push(ENTER) })
    expect(wide.stdout.chunks[0]).toContain('session-00000000…')
    const narrow = await run({ candidates: [candidate()], columns: 12 }, (input) => { input.push(ENTER) })
    expect(narrow.stdout.chunks[0]!.split('\n')[2]).toBe('> 1. 2026-08')
  })

  it('settles dismissed when stdin closes, leaving the closed stream alone', async () => {
    const { outcome, stdin, stdout } = await run({}, (input) => { input.close() })
    expect(outcome).toEqual({ kind: 'dismissed' })
    expect(stdin.rawModes).toEqual([true])
    expect(stdout.chunks).toHaveLength(2)
  })

  it('settles dismissed before touching the streams when the signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { outcome, stdin, stdout } = await run({}, undefined, controller.signal)
    expect(outcome).toEqual({ kind: 'dismissed' })
    expect(stdout.chunks).toEqual([])
    expect(stdin.rawModes).toEqual([])
  })

  it('settles dismissed and restores line mode when aborted mid-pick', async () => {
    const controller = new AbortController()
    const stdin = new FakeStdin()
    const stdout = new FakeStdout(30, 100)
    const settled = pickResumeSession({
      candidates: [candidate()],
      color: false,
      stdin,
      stdout,
      signal: controller.signal,
    })
    controller.abort()
    const outcome = await settled
    expect(outcome).toEqual({ kind: 'dismissed' })
    expect(stdin.rawModes).toEqual([true, false])
    expect(stdout.chunks).toHaveLength(2)
    // A key arriving after settlement finds no listener attached.
    stdin.push(ENTER)
    expect(stdout.chunks).toHaveLength(2)
  })
})
