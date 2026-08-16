/**
 * The one PTY-driven test this repository sanctions: the subject IS the
 * terminal takeover, which pipes cannot prove. It boots the shipped `tui`
 * profile through the `dsh` launcher against the keyless mock model, drives a
 * real conversation, and leaves through `/exit`.
 *
 * Everything else about this front door is covered by pipes and unit suites.
 */

import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createTuiHarness } from '../../../../apps/cli/tests/tui-interaction.harness.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const ANSWER = 'Mock model answering the terminal.'
const TTY_REFUSAL = 'dsh-tui: the terminal front door needs a TTY on both stdin and stdout; use the headless app for pipes and automation'

/** How long a source launch of the whole profile may take before the first draw. */
const BOOT_TIMEOUT_MS = 60_000

/** How long one mock-backed turn may take to reach the screen. */
const TURN_TIMEOUT_MS = 30_000

/** node-pty is resolved from the package that owns the PTY dependency. */
const requireFromSubprocess = createRequire(
  join(REPO_ROOT, 'packages/subprocess/subprocess-local/package.json'),
)

interface PtyProcess {
  write(data: string): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess
}

/** Shell-quote one fixed test path or argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Run one source CLI command with its controlling streams supplied by a PTY. */
async function runPty(
  file: string,
  args: string[],
  home: string,
): Promise<{ exitCode: number; raw: string }> {
  const pty = requireFromSubprocess('node-pty') as PtyModule
  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    },
  })
  let raw = ''
  child.onData((data) => { raw += data })
  const exited = new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => { resolve(exitCode) })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`PTY command did not exit; output:\n${raw}`)) }, BOOT_TIMEOUT_MS)
      }),
    ])
    return { exitCode, raw }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    child.kill()
  }
}

/** Everything the terminal drew, with the control sequences stripped. */
function plain(raw: string): string {
  return raw
    .replaceAll(/\x1b\][^\x07]*\x07/gu, '')
    .replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
    .replaceAll(/\x1b[<>=][a-zA-Z0-9]*/gu, '')
}

/**
 * Resolve once the condition holds, polling past the mock-backed turn's
 * latency; for states the screen cannot distinguish, like a repeated answer.
 * @param ready - the condition to poll.
 * @param timeoutMs - how long to wait before failing.
 */
async function when(ready: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (!ready()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition did not hold in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Read the one session id a harness home persists, from its session
 * directory: `<root>/<project>/<session-id>/session.jsonl`.
 * @param sessionsRoot - the harness home's `sessions` directory.
 * @returns the encoded session id the resume flag names.
 */
function soleSessionId(sessionsRoot: string): string {
  const projects = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(sessionsRoot, entry.name))
  const sessionDirs = projects.flatMap(project =>
    readdirSync(project, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(project, entry.name)))
  if (sessionDirs.length !== 1) {
    throw new Error(`expected exactly one persisted session, found ${String(sessionDirs.length)}`)
  }
  return basename(sessionDirs[0] as string)
}

/** One driven terminal session. */
interface Terminal {
  /** Type raw text without submitting. */
  type(text: string): void
  /** Type a line and submit it. */
  submit(line: string): void
  /** Resolve once the screen contains `text`, or reject at `timeoutMs`. */
  waitFor(text: string, timeoutMs: number): Promise<void>
  /** The screen so far, control sequences stripped. */
  screen(): string
  /** Resolve with the process exit code. */
  exited: Promise<number>
  kill(): void
}

/**
 * Launch the shipped terminal profile under a real PTY.
 * @param baseUrl - the mock model's OpenAI-compatible base URL.
 * @param over - the terminal geometry to launch with.
 * @returns the driven terminal.
 */
function launch(baseUrl: string, over: { cols?: number; rows?: number } = {}): Terminal {
  const pty = requireFromSubprocess('node-pty') as PtyModule
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-pty-'))
  const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', BIN, '--profile', 'tui'], {
    name: 'xterm-256color',
    cols: over.cols ?? 100,
    rows: over.rows ?? 30,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_API_KEY: 'mock-key',
      DSH_TELEMETRY_DISABLED: '1',
    },
  })
  let screenText = ''
  const waiters: { text: string; resolve: () => void }[] = []
  child.onData((data) => {
    screenText += data
    const drawn = plain(screenText)
    for (const waiter of waiters.splice(0)) {
      if (drawn.includes(waiter.text)) waiter.resolve()
      else waiters.push(waiter)
    }
  })
  const exited = new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => { resolve(exitCode) })
  })
  const waitFor = (text: string, timeoutMs: number): Promise<void> => {
    if (plain(screenText).includes(text)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${JSON.stringify(text)}; screen was:\n${plain(screenText)}`))
      }, timeoutMs)
      waiters.push({ text, resolve: () => { clearTimeout(timer); resolve() } })
    })
  }
  return {
    type(text: string): void { child.write(text) },
    submit(line: string): void { child.write(`${line}\r`) },
    waitFor,
    screen(): string { return plain(screenText) },
    exited,
    kill(): void { child.kill() },
  }
}

let server: MockLlmServer | undefined

beforeAll(async () => {
  server = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: ANSWER,
  })
})

afterAll(async () => { await server?.close() })

describe('the dsh terminal profile under a real PTY', () => {
  it('draws the conversation and leaves through /exit', async () => {
    const terminal = launch(server?.baseURL ?? '')
    try {
      await terminal.waitFor('ready', BOOT_TIMEOUT_MS)
      terminal.submit('hello there')
      await terminal.waitFor('hello there', TURN_TIMEOUT_MS)
      await terminal.waitFor(ANSWER, TURN_TIMEOUT_MS)
      terminal.submit('/exit')
      await expect(terminal.exited).resolves.toBe(0)
    } finally {
      terminal.kill()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS * 3)

  it('offers the live slash menu and runs /help without a model turn', async () => {
    const terminal = launch(server?.baseURL ?? '')
    try {
      await terminal.waitFor('ready', BOOT_TIMEOUT_MS)
      terminal.type('/')
      await terminal.waitFor('compact', TURN_TIMEOUT_MS)
      await terminal.waitFor('Compact older conversation history', TURN_TIMEOUT_MS)
      terminal.type('\x1b')
      await new Promise(resolve => setTimeout(resolve, 200))
      terminal.type('\x7f')
      await new Promise(resolve => setTimeout(resolve, 200))

      const requestsBefore = server?.requests.length ?? 0
      terminal.submit('/help')
      await terminal.waitFor('/help — List the commands this terminal resolves', TURN_TIMEOUT_MS)
      await terminal.waitFor('/exit — Leave the terminal session', TURN_TIMEOUT_MS)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(server?.requests.length ?? 0).toBe(requestsBefore)
      expect(terminal.screen()).toContain('0 tokens')

      terminal.submit('/exit')
      await expect(terminal.exited).resolves.toBe(0)
    } finally {
      terminal.kill()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS * 3)

  it('esc with a menu open dismisses it and queued work still runs', async () => {
    const terminal = launch(server?.baseURL ?? '')
    try {
      await terminal.waitFor('ready', BOOT_TIMEOUT_MS)
      // Open a turn, then queue a second prompt behind it.
      terminal.submit('first question')
      await terminal.waitFor('first question', TURN_TIMEOUT_MS)
      terminal.submit('second question')
      await terminal.waitFor('second question', TURN_TIMEOUT_MS)

      // Open the slash menu, dismiss it with esc: the running turn keeps its
      // queued follow-up — both prompts still reach the model.
      terminal.type('/')
      await terminal.waitFor('Compact older conversation history', TURN_TIMEOUT_MS)
      terminal.type('\x1b')
      await new Promise(resolve => setTimeout(resolve, 200))
      terminal.type('\x7f')
      await new Promise(resolve => setTimeout(resolve, 200))

      await terminal.waitFor(ANSWER, TURN_TIMEOUT_MS)
      await new Promise(resolve => setTimeout(resolve, TURN_TIMEOUT_MS))
      expect(server?.requests.length ?? 0).toBeGreaterThanOrEqual(2)

      // The dismissed menu released the editor: the typed line submits.
      terminal.submit('/exit')
      await expect(terminal.exited).resolves.toBe(0)
    } finally {
      terminal.kill()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS * 4)

  it('yields the menu on a 20x5 terminal and keeps the input usable', async () => {
    const terminal = launch(server?.baseURL ?? '', { cols: 20, rows: 5 })
    try {
      await terminal.waitFor('ready', BOOT_TIMEOUT_MS)
      terminal.type('/')
      await new Promise(resolve => setTimeout(resolve, 500))
      // No room for a candidate row: the menu stays closed and the input row
      // keeps its place.
      expect(terminal.screen()).not.toContain('Compact older')
      expect(terminal.screen()).toContain('/')

      terminal.type('exit')
      terminal.submit('')
      await expect(terminal.exited).resolves.toBe(0)
    } finally {
      terminal.kill()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS)

  it.each([
    ['stdin redirected', `${shellQuote(process.execPath)} --import tsx/esm ${shellQuote(BIN)} < /dev/null`],
    ['stdout piped', `set -o pipefail; ${shellQuote(process.execPath)} --import tsx/esm ${shellQuote(BIN)} | sed 's/^/[PIPE] /'`],
  ])('prints one clean refusal with %s', async (_label, command) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-refusal-'))
    try {
      const result = await runPty('/bin/zsh', ['-c', command], home)
      expect(result.exitCode).toBe(1)
      expect(result.raw.replaceAll('\r\n', '\n')).toBe(`${TTY_REFUSAL}\n`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, BOOT_TIMEOUT_MS)

  it('refuses an unknown resume before entering the alternate screen', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-missing-'))
    const id = 'session-00000000-0000-4000-8000-000000000000'
    try {
      const result = await runPty(process.execPath, ['--import', 'tsx/esm', BIN, '--resume', id], home)
      expect(result.exitCode).toBe(1)
      expect(result.raw).toContain(`cannot resume session "${id}": session "${id}" not found`)
      expect(result.raw).not.toContain('\x1b[?1049h')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, BOOT_TIMEOUT_MS)

  it('refuses a corrupt resume before entering the alternate screen', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-corrupt-'))
    const id = 'session-11111111-1111-4111-8111-111111111111'
    const artifact = join(home, 'sessions', '_no-cwd', id, 'session.jsonl.zstd')
    mkdirSync(join(artifact, '..'), { recursive: true })
    writeFileSync(artifact, 'truncated-zstandard-frame')
    try {
      const result = await runPty(process.execPath, ['--import', 'tsx/esm', BIN, '--resume', id], home)
      expect(result.exitCode).toBe(1)
      expect(result.raw).toContain(`cannot resume session "${id}": corrupt Zstandard session log`)
      expect(result.raw).not.toContain('\x1b[?1049h')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, BOOT_TIMEOUT_MS)
})

describe('the /model command under a real PTY', () => {
  it('picks from the live catalog, survives esc with queued work, and routes the next request', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', BOOT_TIMEOUT_MS)

      // Open a turn, then queue a second prompt behind it.
      harness.submit('first question')
      await harness.waitFor('first question', TURN_TIMEOUT_MS)
      harness.submit('second question')
      await harness.waitFor('second question', TURN_TIMEOUT_MS)

      // The picker lists the composition's advertised routes over the live
      // adapter registry, with the current route marked.
      harness.submit('/model')
      await harness.waitFor('deepseek-official/deepseek-v4-pro', TURN_TIMEOUT_MS)
      await harness.waitFor('deepseek-v4-flash', TURN_TIMEOUT_MS)

      // Dismiss with esc: the running turn and its queued follow-up still
      // reach the model, because a dismissed picker cancels nothing.
      harness.key('esc')
      await harness.waitFor(ANSWER, TURN_TIMEOUT_MS)
      await new Promise(resolve => setTimeout(resolve, TURN_TIMEOUT_MS))
      expect(server?.requests.length ?? 0).toBeGreaterThanOrEqual(2)

      // A numbered pick applies mid-session: the notice names the route and
      // the footer carries it. The reopen draws text the first open already
      // put on the cumulative screen, so give the panel the keyboard before
      // typing; the switched-to notice is the assertion that the pick landed.
      harness.submit('/model')
      await new Promise(resolve => setTimeout(resolve, 500))
      harness.type('2')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-pro', TURN_TIMEOUT_MS)

      // The footer restates the new route immediately, before any further
      // request exists to log it: the bottom of the screen names v4-pro while
      // the request count has not moved.
      const requestCount = (): number => server?.requests.length ?? 0
      const beforeFooter = requestCount()
      const footerNamed = (): boolean => harness.snapshot()
        .split('\n')
        .slice(-4)
        .some(line => line.includes('deepseek-official/deepseek-v4-pro'))
      await when(footerNamed, TURN_TIMEOUT_MS)
      expect(requestCount()).toBe(beforeFooter)

      // The next request actually runs on the switched route.
      const before = requestCount()
      harness.submit('after the switch')
      await harness.waitFor('after the switch', TURN_TIMEOUT_MS)
      await when(() => (server?.requests.length ?? 0) > before, TURN_TIMEOUT_MS)
      const served = server?.requests.slice(before) ?? []
      expect((served.at(-1)?.body as { model?: string }).model).toBe('deepseek-v4-pro')

      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS * 6)

  it('switches directly by id and refuses an unknown id loudly', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', BOOT_TIMEOUT_MS)

      harness.submit('/model deepseek-v4-pro')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-pro', TURN_TIMEOUT_MS)
      await harness.waitFor('deepseek-official/deepseek-v4-pro', TURN_TIMEOUT_MS)

      harness.submit('/model gpt-neo')
      await harness.waitFor('unknown model "gpt-neo"', TURN_TIMEOUT_MS)
      await harness.waitFor('available: deepseek-official/deepseek-v4-flash,', TURN_TIMEOUT_MS)
      await harness.waitFor('deepseek-v4-pro', TURN_TIMEOUT_MS)

      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS * 3)

  it('yields the picker on a 20x5 terminal and keeps the input usable', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '', cols: 20, rows: 5 })
    try {
      await harness.waitFor('ready', BOOT_TIMEOUT_MS)
      harness.submit('/model')
      await new Promise(resolve => setTimeout(resolve, 500))
      // No candidate row ever drew: the only route ids this screen could have
      // shown are the catalog's, and none is present.
      expect(harness.snapshot()).not.toContain('v4-pro')
      // No invisible list captured the keyboard: typed keys reach the editor.
      harness.type('q')
      await harness.waitFor('q', TURN_TIMEOUT_MS)
      harness.key('backspace')
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS)

  it('restores a switched model on --resume from the session log, with no pick involved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-'))
    try {
      // Boot one: switch the route, run a request on it, and leave so the
      // log flushes with the switched header.
      const first = createTuiHarness({ baseUrl: server?.baseURL ?? '', home })
      try {
        await first.waitFor('ready', BOOT_TIMEOUT_MS)
        first.submit('/model deepseek-v4-pro')
        await first.waitFor('Model switched to deepseek-official/deepseek-v4-pro', TURN_TIMEOUT_MS)
        const before = server?.requests.length ?? 0
        first.submit('restore probe')
        await first.waitFor('restore probe', TURN_TIMEOUT_MS)
        await when(() => (server?.requests.length ?? 0) > before, TURN_TIMEOUT_MS)
        const served = server?.requests.slice(before) ?? []
        expect((served.at(-1)?.body as { model?: string }).model).toBe('deepseek-v4-pro')
        expect(await first.exit()).toBe(0)
      } catch (error) {
        await first.dispose()
        throw error
      }

      // The persisted log owns the session id: one session dir under the
      // harness home's sessions root.
      const sessionId = soleSessionId(join(home, 'sessions'))

      // Boot two resumes that log. The restored route comes from the log —
      // not from a pick, and not from the deployment default (flash).
      const second = createTuiHarness({ baseUrl: server?.baseURL ?? '', home, args: ['--resume', sessionId] })
      try {
        await second.waitFor('ready', BOOT_TIMEOUT_MS)
        const resumedBefore = server?.requests.length ?? 0
        second.submit('after the resume')
        await second.waitFor('after the resume', TURN_TIMEOUT_MS)
        await when(() => (server?.requests.length ?? 0) > resumedBefore, TURN_TIMEOUT_MS)
        const resumed = server?.requests.slice(resumedBefore) ?? []
        expect((resumed.at(-1)?.body as { model?: string }).model).toBe('deepseek-v4-pro')
        expect(await second.exit()).toBe(0)
      } catch (error) {
        await second.dispose()
        throw error
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, (BOOT_TIMEOUT_MS + TURN_TIMEOUT_MS) * 3)
})
