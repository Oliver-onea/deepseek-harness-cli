/** The terminal app's flag parsing and the startup values its rows read. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionHeader } from '@deepseek-ai/dsh-session-persistence'
import type { PickerStdin, PickerStdout } from '@deepseek-ai/dsh-tui'
import { apply, internals as tuiInternals, resolveStartup, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  tuiInternals.stdin = process.stdin
  tuiInternals.stdout = process.stdout
  tuiInternals.interactive = () => process.stdin.isTTY && process.stdout.isTTY
})

/** The stdin fake a driven picker reads: pushes buffer until a listener subscribes. */
class FakeStdin implements PickerStdin {
  readonly rawModes: boolean[] = []
  private readonly pending: (string | Buffer)[] = []
  private readonly dataListeners = new Set<(chunk: string | Buffer) => void>()

  on(_event: 'data', listener: (chunk: string | Buffer) => void): void {
    this.dataListeners.add(listener)
    for (const chunk of this.pending.splice(0)) listener(chunk)
  }

  off(event: 'data' | 'close', listener: ((chunk: string | Buffer) => void) & (() => void)): void {
    if (event === 'data') this.dataListeners.delete(listener)
  }

  once(_event: 'close', _listener: () => void): void {}


  setRawMode(mode: boolean): void {
    this.rawModes.push(mode)
  }

  resume(): void {}

  pause(): void {}

  push(chunk: string | Buffer): void {
    if (this.dataListeners.size === 0) {
      this.pending.push(chunk)
      return
    }
    for (const listener of [...this.dataListeners]) listener(chunk)
  }
}

/** The stdout fake a driven picker draws on. */
class FakeStdout implements PickerStdout {
  readonly chunks: string[] = []
  constructor(readonly rows?: number, readonly columns?: number) {}

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
}

/** Point the startup provider's picker at fake TTY streams. */
function interactiveTerminal(rows = 30, columns = 100): { stdin: FakeStdin; stdout: FakeStdout } {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout(rows, columns)
  tuiInternals.stdin = stdin
  tuiInternals.stdout = stdout
  tuiInternals.interactive = () => true
  return { stdin, stdout }
}

/** One persisted header with stable defaults. */
function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 0,
    id: SessionId('session-00000000-0000-4000-8000-000000000001'),
    createdAt: new Date(2026, 7, 16, 12, 3).getTime(),
    cwd: '/work',
    ...over,
  }
}

/** Parse one argv through the REAL cmdline host and read what it provided. */
async function parse(argv: readonly string[], persistence: Partial<Pick<SessionPersistence, 'inspect' | 'list'>> = {}): Promise<{
  values: TuiStartupValues | undefined
  exits: number[]
  output: string
}> {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const observing = { write: (chunk: string) => { output += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  provideCmdline(ctx, { args: [...argv], exit: (code: number) => { exits.push(code) } })
  ctx.provide('sessionPersistence', {
    inspect: async (id: SessionId) => ({ meta: { id, version: 0, createdAt: 0, delegationDepth: 0 }, events: [] }),
    ...persistence,
  } as unknown as SessionPersistence)
  await ctx.plugin({ name: 'tui-startup-under-test', inject: ['cmdlineArgs', 'sessionPersistence'], apply })
  await ctx.fiber.await()
  return { values: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined, exits, output }
}

describe('resolveStartup', () => {
  it('mints a fresh session and configures a fresh agent in the invocation workspace', () => {
    const values = resolveStartup({}, '', '/work')
    expect(values.session).toMatch(/^session-/u)
    expect(values.agent).toEqual({ id: 'tui', sessionId: values.session, cwd: '/work' })
    expect(values.color).toBe(true)
    expect(values).not.toHaveProperty('task')
  })

  it('keeps a resumed session id and asks the loop to resume rather than create', () => {
    const values = resolveStartup({ resume: 'session-abc' }, '', '/work')
    expect(values.session).toBe('session-abc')
    expect(values.agent).toEqual({ id: 'tui', resumeSessionId: 'session-abc' })
  })

  it('treats an empty resume value as no resume', () => {
    const values = resolveStartup({ resume: '' }, '', '/work')
    expect(values.agent.resumeSessionId).toBeUndefined()
    expect(values.agent.sessionId).toBe(values.session)
  })

  it('carries the named route onto the configured agent', () => {
    const values = resolveStartup({ provider: 'p', model: 'm' }, '', '/work')
    expect(values.agent.provider).toBe('p')
    expect(values.agent.model).toBe('m')
  })

  it('carries a first task and drops a blank one', () => {
    expect(resolveStartup({}, 'run the tests', '/work').task).toBe('run the tests')
    expect(resolveStartup({}, '   ', '/work')).not.toHaveProperty('task')
  })

  it('turns styling off for --no-color', () => {
    expect(resolveStartup({ color: false }, '', '/work').color).toBe(false)
  })
})

describe('the dsh terminal command line', () => {
  it('provides startup values for a bare launch', async () => {
    const { values } = await parse([])
    expect(values?.session).toMatch(/^session-/u)
    expect(values?.task).toBeUndefined()
  })

  it('joins a multi-word task positional', async () => {
    const { values } = await parse(['run', 'the', 'tests'])
    expect(values?.task).toBe('run the tests')
  })

  it('reads the resume, route, and color flags', async () => {
    const inspect = vi.fn(async (id: SessionId) => ({
      meta: { id: SessionId(id), version: 0, createdAt: 0, delegationDepth: 0 },
      events: [],
    }))
    const { values } = await parse(['--resume', 'session-x', '--model', 'm', '--provider', 'p', '--no-color'], { inspect })
    expect(values?.session).toBe('session-x')
    expect(values?.agent.model).toBe('m')
    expect(values?.agent.provider).toBe('p')
    expect(values?.color).toBe(false)
    expect(inspect).toHaveBeenCalledWith(SessionId('session-x'))
  })

  it('refuses an unknown or unreadable resume before publishing startup values', async () => {
    const inspect = vi.fn(() => Promise.reject(new Error('session "session-broken" not found')))
    await expect(parse(['--resume', 'session-broken'], { inspect })).rejects.toThrow(
      'cannot resume session "session-broken": session "session-broken" not found; check the session id and stored log, or omit --resume to start a new session',
    )
  })

  it('renders a non-Error persistence rejection at the durable boundary', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the durable-boundary case under test
    await expect(parse(['--resume', 'session-broken'], { inspect: () => Promise.reject('storage offline') })).rejects.toThrow(
      'cannot resume session "session-broken": storage offline; check the session id and stored log, or omit --resume to start a new session',
    )
  })

  it('composes neither an agent nor a screen for --help', async () => {
    const { values, output, exits } = await parse(['--help'])
    expect(values).toBeUndefined()
    expect(output).toContain('Open the DeepSeek Harness terminal')
    expect(exits).toEqual([0])
  })

  it('rejects an empty --resume rather than starting a fresh session by surprise', async () => {
    const { values, output, exits } = await parse(['--resume', ''])
    expect(values).toBeUndefined()
    expect(output).toContain('--resume needs a session id')
    expect(exits).toEqual([1])
  })
})

describe('the bare --resume launch picker', () => {
  it('resumes the picked session exactly as a named one', async () => {
    const { stdin, stdout } = interactiveTerminal()
    const inspect = vi.fn(async (id: SessionId) => ({
      meta: { id, version: 0, createdAt: 0, delegationDepth: 0 },
      events: [],
    }))
    const promise = parse(['--resume'], {
      inspect,
      list: async () => [
        header({ id: SessionId('session-older'), createdAt: new Date(2026, 7, 1, 9, 0).getTime() }),
        header({ id: SessionId('session-newer'), createdAt: new Date(2026, 7, 16, 12, 3).getTime() }),
        header({ id: SessionId('session-child'), origin: 'subagent' }),
      ],
    })
    // The test invariant host defers plugin startup behind its readiness
    // chain, so the draw arrives asynchronously: await the list before
    // reading or keying it.
    await vi.waitFor(() => { expect(stdout.chunks.length).toBeGreaterThan(0) })
    // The picker drew before any service existed, and enter took the newest
    // top-level session through the same inspection a named resume takes.
    expect(stdout.chunks[0]).toContain('Resume a session')
    expect(stdout.chunks[0]).toContain('> 1. 2026-08-16 12:03')
    expect(stdout.chunks[0]).not.toContain('session-child')
    stdin.push('\r')
    const { values } = await promise
    expect(values?.session).toBe('session-newer')
    expect(values?.agent).toEqual({ id: 'tui', resumeSessionId: 'session-newer' })
    expect(inspect).toHaveBeenCalledWith(SessionId('session-newer'))
  })

  it('refuses a picker with no TTY, naming the explicit form', async () => {
    await expect(parse(['--resume'], { list: async () => [header()] })).rejects.toThrow(
      'dsh: --resume without a session id opens a picker and needs a TTY on both stdin and stdout; name the session explicitly with dsh --resume <session>',
    )
  })

  it('refuses an unlistable store, naming the failure', async () => {
    interactiveTerminal()
    await expect(parse(['--resume'], {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the unlistable-store case under test
      list: () => Promise.reject('storage offline'),
    })).rejects.toThrow(
      'dsh: cannot list persisted sessions: storage offline; name the session explicitly with dsh --resume <session>',
    )
  })

  it('refuses a store with nothing to resume', async () => {
    interactiveTerminal()
    await expect(parse(['--resume'], { list: async () => [] })).rejects.toThrow(
      'dsh: there are no persisted sessions to resume; run dsh without --resume to start a fresh one',
    )
    await expect(parse(['--resume'], {
      list: async () => [header({ id: SessionId('session-child'), origin: 'subagent' })],
    })).rejects.toThrow(
      'dsh: only subagent child sessions are persisted, and a child is not a conversation to resume; run dsh without --resume to start a fresh one',
    )
  })

  it('refuses a dismissed picker without resuming or creating anything', async () => {
    const { stdin } = interactiveTerminal()
    const promise = parse(['--resume'], { list: async () => [header()] })
    stdin.push('\x1b')
    await expect(promise).rejects.toThrow(
      'dsh: no session chosen; run dsh to start a fresh session or name one with dsh --resume <session>',
    )
  })

  it('refuses a terminal too small to draw a candidate row', async () => {
    interactiveTerminal(5, 20)
    await expect(parse(['--resume'], { list: async () => [header()] })).rejects.toThrow(
      'dsh: the terminal is too small for the resume picker; name the session explicitly with dsh --resume <session>',
    )
  })

  it('refuses a picked session whose stored log fails inspection, like a named resume', async () => {
    const { stdin } = interactiveTerminal()
    const promise = parse(['--resume'], {
      inspect: () => Promise.reject(new Error('corrupt Zstandard session log')),
      list: async () => [header()],
    })
    stdin.push('\r')
    await expect(promise).rejects.toThrow(
      'cannot resume session "session-00000000-0000-4000-8000-000000000001": corrupt Zstandard session log',
    )
  })

  it('aborts a pending picker when the tree disposes, so raw stdin cannot outlive it', async () => {
    const { stdin } = interactiveTerminal()
    const ctx = new Context()
    const exits: number[] = []
    provideCmdline(ctx, { args: ['--resume'], exit: (code: number) => { exits.push(code) } })
    ctx.provide('sessionPersistence', {
      inspect: async (id: SessionId) => ({ meta: { id, version: 0, createdAt: 0, delegationDepth: 0 }, events: [] }),
      list: async () => [header()],
    } as unknown as SessionPersistence)
    const started = ctx.plugin({ name: 'tui-startup-under-test', inject: ['cmdlineArgs', 'sessionPersistence'], apply })
    // The picker owns raw stdin only while its list is up, so dispose once
    // raw mode is on, not after a fixed delay.
    await vi.waitFor(() => { expect(stdin.rawModes).toEqual([true]) })
    await ctx.fiber.dispose()
    await expect(started).rejects.toThrow('no session chosen')
    expect(stdin.rawModes).toEqual([true, false])
  })
})
