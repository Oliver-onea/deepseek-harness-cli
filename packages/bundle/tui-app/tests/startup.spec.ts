/** The terminal app's flag parsing and the startup values its rows read. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { apply, resolveStartup, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** Parse one argv through the REAL cmdline host and read what it provided. */
async function parse(argv: readonly string[]): Promise<{
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
  await ctx.plugin({ name: 'tui-startup-under-test', inject: ['cmdlineArgs'], apply })
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
    const { values } = await parse(['--resume', 'session-x', '--model', 'm', '--provider', 'p', '--no-color'])
    expect(values?.session).toBe('session-x')
    expect(values?.agent.model).toBe('m')
    expect(values?.agent.provider).toBe('p')
    expect(values?.color).toBe(false)
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
