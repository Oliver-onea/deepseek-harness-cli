import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LocalCredentialProvider } from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-cmd-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const fiber = ctx.plugin(LocalCredentialProvider, {
    path: join(dir, '.credentials.yaml'),
    watch: false,
  })
  cleanups.push(async () => {
    await fiber.dispose()
  })
  await fiber
  const session = ctx.sessions.create(SessionId('test-session'))
  const agent = { id: session.id, session } as Agent
  return { ctx, agent }
}

describe('/key command in credentials-local', () => {
  it('registers the /key command in the commands registry with expected descriptor', async () => {
    const dir = await tempDir()
    const { ctx, agent } = await boot(dir)
    const list = ctx.commands.list(agent)
    const keyCommand = list.find(cmd => cmd.name === 'key')
    expect(keyCommand).toBeDefined()
    expect(keyCommand).toEqual({
      name: 'key',
      description: 'Store an API key through the credentials service',
      input: { hint: '[<ref>] <value>' },
    })
  })

  it('stores DEEPSEEK_API_KEY when given a single token secret', async () => {
    const dir = await tempDir()
    const { ctx, agent } = await boot(dir)
    const settled = await ctx.commands.execute(agent, '/key sk-deepseek-test-key-12345', new AbortController().signal)
    expect(settled).toBeDefined()
    expect(settled?.result).toEqual({
      kind: 'success',
      text: 'Stored DEEPSEEK_API_KEY.',
    })

    const resolved = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
    expect(resolved).toEqual({ value: 'sk-deepseek-test-key-12345', source: 'file' })
  })

  it('stores a specified ref when given ref and secret', async () => {
    const dir = await tempDir()
    const { ctx, agent } = await boot(dir)
    const settled = await ctx.commands.execute(agent, '/key ANTHROPIC_API_KEY sk-ant-test-key-67890', new AbortController().signal)
    expect(settled).toBeDefined()
    expect(settled?.result).toEqual({
      kind: 'success',
      text: 'Stored ANTHROPIC_API_KEY.',
    })

    const resolved = await ctx.credentials.resolve(credentialRef('ANTHROPIC_API_KEY'))
    expect(resolved).toEqual({ value: 'sk-ant-test-key-67890', source: 'file' })
  })

  it('returns usage error on empty arguments', async () => {
    const dir = await tempDir()
    const { ctx, agent } = await boot(dir)
    const settled = await ctx.commands.execute(agent, '/key', new AbortController().signal)
    expect(settled?.result).toEqual({
      kind: 'error',
      text: 'Usage: /key <value> or /key <ref> <value>',
    })
  })

  it('returns error on invalid ref name', async () => {
    const dir = await tempDir()
    const { ctx, agent } = await boot(dir)
    const settled = await ctx.commands.execute(agent, '/key invalid-ref! secret-val', new AbortController().signal)
    expect(settled?.result).toMatchObject({
      kind: 'error',
    })
    expect(settled?.result.text).toContain('invalid-ref!')
  })

  it('reports error when the credential is shadowed by the launching environment', async () => {
    const dir = await tempDir()
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-secret')
    const { ctx, agent } = await boot(dir)
    const settled = await ctx.commands.execute(agent, '/key sk-new-secret', new AbortController().signal)
    expect(settled?.result.kind).toBe('error')
    expect(settled?.result.text).toContain('supplied read-only by the launching environment, so set would be shadowed')
  })

  it('never leaks the secret into logged session events or command done text', async () => {
    const dir = await tempDir()
    const { ctx, agent } = await boot(dir)
    const SECRET = 'sk-super-secret-password-never-leak-9999'
    await ctx.commands.execute(agent, `/key DEEPSEEK_API_KEY ${SECRET}`, new AbortController().signal)

    const eventsJson = JSON.stringify(agent.session.events)
    expect(eventsJson).not.toContain(SECRET)

    // Check command/run event specifically: args must be undefined (recordInput: false)
    const runEvent = agent.session.events.find(e => e.type === 'command/run')
    expect(runEvent).toBeDefined()
    expect(runEvent?.data).toMatchObject({
      name: 'key',
      source: { kind: 'user' },
    })
    expect(runEvent?.data.args).toBeUndefined()

    // Check command/done event
    const doneEvent = agent.session.events.find(e => e.type === 'command/done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent?.data).toEqual({
      commandId: runEvent?.data.commandId,
      kind: 'success',
      text: 'Stored DEEPSEEK_API_KEY.',
    })
  })
})
