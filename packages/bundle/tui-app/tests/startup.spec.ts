/** The terminal app's flag parsing and the startup values its rows read. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { apply, resolveStartup, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** Parse one argv through the REAL cmdline host and read what it provided. */
async function parse(argv: readonly string[], inspect: (id: SessionId) => Promise<SessionInspection> = async id => ({
  meta: { id, version: 0, createdAt: 0, delegationDepth: 0 },
  events: [],
})): Promise<{
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
  ctx.provide('sessionPersistence', { inspect } as unknown as SessionPersistence)
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
    const { values } = await parse(['--resume', 'session-x', '--model', 'm', '--provider', 'p', '--no-color'], inspect)
    expect(values?.session).toBe('session-x')
    expect(values?.agent.model).toBe('m')
    expect(values?.agent.provider).toBe('p')
    expect(values?.color).toBe(false)
    expect(inspect).toHaveBeenCalledWith(SessionId('session-x'))
  })

  it('refuses an unknown or unreadable resume before publishing startup values', async () => {
    const inspect = vi.fn(() => Promise.reject(new Error('session "session-broken" not found')))
    await expect(parse(['--resume', 'session-broken'], inspect)).rejects.toThrow(
      'cannot resume session "session-broken": session "session-broken" not found; check the session id and stored log, or omit --resume to start a new session',
    )
  })

  it('renders a non-Error persistence rejection at the durable boundary', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the durable-boundary case under test
    await expect(parse(['--resume', 'session-broken'], () => Promise.reject('storage offline'))).rejects.toThrow(
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
