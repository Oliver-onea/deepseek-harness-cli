/**
 * Reusable PTY harness for keystroke-driven terminal-interaction tests.
 *
 * Boots the shipped `dsh --profile tui` under a real PTY against the keyless
 * mock model, drives the session with a typed script, and asserts on the
 * rendered screen. PTY coverage is used only because the subject is terminal
 * takeover; everything else in `apps/cli` is covered by pipes.
 */

import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')

/** node-pty is resolved from the package that owns the PTY dependency. */
const requireFromSubprocess = createRequire(
  join(REPO_ROOT, 'packages/subprocess/subprocess-local/package.json'),
)

interface PtyProcess {
  write(data: string): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
  resize(cols: number, rows: number): void
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess
}

/** Named keys the harness can send. */
export type KeyName =
  | 'enter'
  | 'return'
  | 'esc'
  | 'tab'
  | 'backspace'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ctrl+c'
  | 'ctrl+r'
  | 'ctrl+o'
  | 'space'
  | 'delete'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

const KEY_SEQUENCES: Record<KeyName, string> = {
  enter: '\r',
  return: '\r',
  esc: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl+c': '\x03',
  'ctrl+r': '\x12',
  'ctrl+o': '\x0f',
  space: ' ',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
}

export interface TuiHarnessOptions {
  /** OpenAI-compatible base URL for the keyless mock model. */
  baseUrl: string
  /** PTY columns. */
  cols?: number
  /** PTY rows. */
  rows?: number
  /** Maximum time to wait for one mock-backed turn to reach the screen. */
  turnTimeoutMs?: number
  /** Extra environment variables for the child. */
  env?: Record<string, string>
  /** Extra CLI arguments after `--profile tui`, e.g. `['--resume', id]`. */
  args?: readonly string[]
  /**
   * Reuse an existing harness home instead of minting one, so a second boot
   * can resume a session the first wrote; the caller owns its cleanup.
   */
  home?: string
}

export interface TuiHarness {
  /** Send literal text without submitting it. */
  type(text: string): void
  /** Send one named key. */
  key(name: KeyName): void
  /** Type a line and press Enter. */
  submit(line: string): void
  /**
   * Resolve once the rendered screen contains `text`, or reject at the deadline.
   * Waits on the observable screen state rather than wall-clock sleeps.
   */
  waitFor(text: string, timeoutMs?: number): Promise<void>
  /**
   * Resolve once `predicate(screen)` returns true, or reject at the deadline.
   * Waits on the observable screen state rather than wall-clock sleeps.
   */
  waitUntil(predicate: (screen: string) => boolean, timeoutMs?: number): Promise<void>
  /** Render the current screen as plain text with trailing whitespace stripped. */
  snapshot(): string
  /** Render the current screen with ANSI SGR sequences preserved. */
  ansiSnapshot(): string
  /** Return the process exit code after a graceful `/exit`. */
  exit(): Promise<number>
  /** Send `ctrl+c` and return the process exit code (exits when no turn runs). */
  cancel(): Promise<number>
  /** Kill the process and clean up the temporary home directory. */
  dispose(): Promise<number>
  /** The harness home this boot runs on, for reuse across boots. */
  home(): string
}

interface Cell {
  char: string
  attrs: string
}

/** Minimal VT100/ANSI terminal emulator for the sequences pi-tui emits. */
class TerminalScreen {
  private readonly cols: number
  private readonly rows: number
  private readonly grid: Cell[][]
  private row = 0
  private col = 0
  private currentAttrs = ''
  private pendingEsc = ''

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.grid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: ' ', attrs: '' })),
    )
  }

  /** Feed decoded PTY output characters into the emulator. */
  feed(data: string): void {
    for (const ch of data) {
      const code = ch.codePointAt(0)
      if (code === undefined) continue
      if (this.pendingEsc !== '') {
        this.pendingEsc += ch
        if (this.tryConsumeSequence() || this.pendingEsc.length > 32) {
          // Sequence completed or abandon a runaway partial sequence.
          this.pendingEsc = ''
        }
        continue
      }
      if (code === 0x1b) {
        this.pendingEsc = '\x1b'
        continue
      }
      if (code === 0x0d) {
        this.col = 0
        continue
      }
      if (code === 0x0a) {
        this.row = Math.min(this.rows - 1, this.row + 1)
        this.col = 0
        continue
      }
      if (code === 0x08) {
        this.col = Math.max(0, this.col - 1)
        continue
      }
      if (code === 0x09) {
        this.col = Math.min(this.cols - 1, this.col + (8 - (this.col % 8)))
        continue
      }
      if (code < 0x20 || code === 0x7f) {
        // Ignore other C0 controls and DEL.
        continue
      }
      this.put(ch)
    }
  }

  private put(ch: string): void {
    const row = this.grid[this.row]
    if (row !== undefined && this.col >= 0 && this.col < this.cols) {
      row[this.col] = { char: ch, attrs: this.currentAttrs }
    }
    this.col += 1
  }

  private tryConsumeSequence(): boolean {
    const seq = this.pendingEsc
    if (seq.length < 2) return false
    const second = seq.charCodeAt(1)
    if (second === 0x5b) {
      // CSI sequence: ESC [ params final
      const match = /^\x1b\[([\d;:?]*)([A-Za-z])$/.exec(seq)
      if (!match) return false
      const params = match[1]!
      const final = match[2]!
      const nums = params
        .replace(/\?/g, '')
        .split(';')
        .filter(p => p !== '')
        .map(p => Number.parseInt(p, 10))
        .filter(num => !Number.isNaN(num))
      const n = nums[0] ?? 1
      switch (final) {
        case 'H':
        case 'f':
          this.row = Math.max(0, Math.min(this.rows - 1, (nums[0] ?? 1) - 1))
          this.col = Math.max(0, Math.min(this.cols - 1, (nums[1] ?? 1) - 1))
          return true
        case 'A':
          this.row = Math.max(0, this.row - n)
          return true
        case 'B':
          this.row = Math.min(this.rows - 1, this.row + n)
          return true
        case 'C':
          this.col = Math.min(this.cols - 1, this.col + n)
          return true
        case 'D':
          this.col = Math.max(0, this.col - n)
          return true
        case 'E':
          this.row = Math.min(this.rows - 1, this.row + n)
          this.col = 0
          return true
        case 'F':
          this.row = Math.max(0, this.row - n)
          this.col = 0
          return true
        case 'G':
          this.col = Math.max(0, Math.min(this.cols - 1, n - 1))
          return true
        case 'J':
          if (n === 0 || n === 2) {
            for (const row of this.grid) {
              for (const cell of row) {
                cell.char = ' '
                cell.attrs = ''
              }
            }
          }
          return true
        case 'K': {
          const row = this.grid[this.row]
          if (row !== undefined) {
            for (let c = this.col; c < this.cols; c += 1) {
              row[c] = { char: ' ', attrs: '' }
            }
          }
          return true
        }
        case 'm':
          this.applySgr(nums)
          return true
        case 'h':
        case 'l':
          // Mode set/reset (alternate screen, cursor visibility, etc.).
          return true
        default:
          return false
      }
    }
    if (second === 0x5d) {
      // OSC sequence: ESC ] string BEL or ESC \
      if (/\x07$/.test(seq) || /\x1b\\$/.test(seq)) return true
      return false
    }
    // Two-byte sequence.
    if (seq.length === 2) return true
    return false
  }

  private applySgr(nums: number[]): void {
    if (nums.length === 0) {
      this.currentAttrs = ''
      return
    }
    // For the plain-text renderer attributes are irrelevant; keep a minimal
    // marker only so `ansiSnapshot()` could reconstruct them later.
    this.currentAttrs = `sgr:${nums.join(';')}`
  }

  /** Plain-text snapshot with trailing whitespace stripped per row. */
  plain(): string {
    return this.grid
      .map(row => row.map(cell => cell.char).join('').replace(/\s+$/u, ''))
      .join('\n')
      .replace(/\n+$/u, '')
  }

  /** ANSI snapshot: not yet implemented; falls back to plain text. */
  ansi(): string {
    return this.plain()
  }
}

/** Default PTY geometry used by the existing PTY boot test. */
export const DEFAULT_COLS = 100
export const DEFAULT_ROWS = 30

/** Default timeouts tuned to a source-launched mock-backed terminal. */
export const DEFAULT_BOOT_TIMEOUT_MS = 60_000
export const DEFAULT_TURN_TIMEOUT_MS = 30_000

/**
 * Quiet period required before teardown writes.
 *
 * The CLI boot finishes with async post-render setup (profile watcher
 * registration). Sending `/exit` or `ctrl+c` while that setup is still in
 * flight can leave the top-level `await runProfile(...)` unsettled, so Node
 * exits with code 13. Waiting for the PTY to be idle for this interval lets
 * the event loop drain those startup microtasks without masking a real
 * non-zero exit code.
 */
const TEARDOWN_QUIET_MS = 100

/**
 * Launch the shipped terminal profile under a real PTY and return a harness.
 *
 * The harness uses the keyless mock model at `options.baseUrl`. The caller is
 * responsible for starting and stopping the mock server.
 */
export function createTuiHarness(options: TuiHarnessOptions): TuiHarness {
  const cols = options.cols ?? DEFAULT_COLS
  const rows = options.rows ?? DEFAULT_ROWS
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

  const owned = options.home === undefined
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'dsh-tui-interaction-'))
  if (owned) mkdirSync(join(home, 'sessions'), { recursive: true })

  const pty = requireFromSubprocess('node-pty') as PtyModule
  const screen = new TerminalScreen(cols, rows)

  // Do not leak the parent shell's colour environment into the PTY child:
  // FORCE_COLOR/NO_COLOR change pi-tui output and can add Node warnings.
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    DSH_HOME: home,
    DEEPSEEK_BASE_URL: options.baseUrl,
    DEEPSEEK_API_KEY: 'mock-key',
    DSH_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) childEnv[key] = value
  }

  const child = pty.spawn(
    process.execPath,
    ['--import', 'tsx/esm', BIN, '--profile', 'tui', ...(options.args ?? [])],
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: REPO_ROOT,
      env: childEnv,
    },
  )

  const waiters: { predicate: (text: string) => boolean; resolve: () => void }[] = []
  let lastDataAt = Date.now()
  let quiesceTimer: ReturnType<typeof setTimeout> | undefined
  let quiesceResolve: (() => void) | undefined

  child.onData((data) => {
    lastDataAt = Date.now()
    if (quiesceResolve !== undefined) {
      clearTimeout(quiesceTimer)
      quiesceTimer = setTimeout(() => {
        const resolve = quiesceResolve
        quiesceResolve = undefined
        resolve?.()
      }, TEARDOWN_QUIET_MS)
    }
    screen.feed(data)
    const plain = screen.plain()
    for (const waiter of waiters.splice(0)) {
      if (waiter.predicate(plain)) waiter.resolve()
      else waiters.push(waiter)
    }
  })

  let exited = false
  const exitCode = new Promise<number>((resolve) => {
    child.onExit(({ exitCode: code }) => {
      exited = true
      resolve(code)
    })
  })

  function safeWrite(data: string): void {
    if (exited) return
    try {
      child.write(data)
    } catch {
      // The child exited between the guard and the write; the exit code
      // captured by `exitCode` is the authoritative outcome.
    }
  }

  function quiesce(): Promise<void> {
    if (exited) return Promise.resolve()
    const elapsed = Date.now() - lastDataAt
    if (elapsed >= TEARDOWN_QUIET_MS) return Promise.resolve()
    return new Promise<void>((resolve) => {
      quiesceResolve = resolve
      quiesceTimer = setTimeout(() => {
        quiesceResolve = undefined
        resolve()
      }, TEARDOWN_QUIET_MS - elapsed)
    })
  }

  function waitFor(predicate: (text: string) => boolean, timeoutMs: number): Promise<void> {
    const plain = screen.plain()
    if (predicate(plain)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for screen condition; screen was:\n${screen.plain()}`))
      }, timeoutMs)
      waiters.push({ predicate, resolve: () => { clearTimeout(timer); resolve() } })
    })
  }

  return {
    type(text: string): void {
      child.write(text)
    },
    key(name: KeyName): void {
      const seq = KEY_SEQUENCES[name]
      if (seq === undefined) throw new Error(`unknown key ${JSON.stringify(name)}`)
      child.write(seq)
    },
    submit(line: string): void {
      child.write(`${line}\r`)
    },
    waitFor(text: string, timeoutMs?: number): Promise<void> {
      return waitFor(plain => plain.includes(text), timeoutMs ?? turnTimeoutMs)
    },
    waitUntil(predicate: (screen: string) => boolean, timeoutMs?: number): Promise<void> {
      return waitFor(predicate, timeoutMs ?? turnTimeoutMs)
    },
    snapshot(): string {
      return screen.plain()
    },
    ansiSnapshot(): string {
      return screen.ansi()
    },
    async exit(): Promise<number> {
      await quiesce()
      safeWrite('/exit\r')
      return await exitCode
    },
    async cancel(): Promise<number> {
      await quiesce()
      safeWrite('\x03')
      return await exitCode
    },
    async dispose(): Promise<number> {
      child.kill('SIGKILL')
      const code = await exitCode
      if (owned) rmSync(home, { recursive: true, force: true })
      return code
    },
    /** The harness home, for a caller reusing it across boots. */
    home: (): string => home,
  }
}
