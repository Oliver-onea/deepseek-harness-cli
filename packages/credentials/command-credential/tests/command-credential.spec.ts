import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandCredential from '@deepseek-ai/dsh-command-credential'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-command-credential-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly storePath: string
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Mount the real registry, the real local provider, and this command. */
async function harness(options?: { noCredentials?: boolean }): Promise<Harness> {
  const dir = await tempDir()
  const storePath = join(dir, '.credentials.yaml')
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  if (options?.noCredentials !== true) {
    const provider = ctx.plugin(LocalCredentialProvider, { path: storePath, watch: false })
    cleanups.push(async () => { await provider.dispose() })
    await provider
  }
  const plugin = await ctx.plugin(commandCredential)
  const { agent, session } = stubAgent(ctx, `command-credential-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, storePath, plugin }
}

/** Execute `/credential` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<{ kind: string; text?: string }> {
  const settled = await test.ctx.commands.execute(
    test.agent,
    `/credential${suffix}`,
    new AbortController().signal,
  )
  if (settled === undefined) throw new Error('credential command was not registered')
  return settled.result
}

describe('@deepseek-ai/dsh-command-credential registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandCredential.name).toBe('command-credential')
    expect(commandCredential.inject).toEqual(['commands'])
    expect('default' in commandCredential).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandCredential)).toBe(commandCredential)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'credential',
      description: 'show or store a credential through the credentials service',
      input: { hint: '<REF> [<value>]' },
    })
    expect(test.ctx.commands.find(test.agent, 'credential')).toMatchObject({ recordInput: false })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'credential')).toBeUndefined()
  })

  it('registers ahead of the credentials provider and reports a mounted-check at use time', async () => {
    const test = await harness({ noCredentials: true })
    expect(test.ctx.commands.find(test.agent, 'credential')).toMatchObject({ recordInput: false })
    await expect(run(test, ' DEEPSEEK_API_KEY sk-anything')).resolves.toEqual({
      kind: 'error',
      text: 'no credentials service is mounted, so nothing can store or describe this reference',
    })
    await expect(run(test, ' DEEPSEEK_API_KEY')).resolves.toEqual({
      kind: 'error',
      text: 'no credentials service is mounted, so nothing can store or describe this reference',
    })
  })
})

describe('parseInput', () => {
  const { parseInput } = commandCredential

  it('rejects an empty line with the usage text', () => {
    expect(parseInput('')).toMatchObject({ kind: 'error' })
    expect(parseInput('  \n\t ')).toMatchObject({ kind: 'error' })
  })

  it('treats one token as a description request', () => {
    expect(parseInput(' DEEPSEEK_API_KEY ')).toEqual({ kind: 'describe', refText: 'DEEPSEEK_API_KEY' })
  })

  it('treats a trailing-whitespace-only remainder as a description request', () => {
    expect(parseInput('DEEPSEEK_API_KEY   ')).toEqual({ kind: 'describe', refText: 'DEEPSEEK_API_KEY' })
  })

  it('splits the first token from the value and keeps inner whitespace', () => {
    expect(parseInput('MY_REF  spaced value ')).toEqual({ kind: 'store', refText: 'MY_REF', value: 'spaced value' })
  })
})

describe('describeLine', () => {
  const ref = credentialRef('SOME_REF')
  const { describeLine } = commandCredential

  it('invites a write when unconfigured and writable', () => {
    expect(describeLine(ref, { configured: false, writable: true }))
      .toBe('SOME_REF: not configured; store a value with /credential SOME_REF <value>')
  })

  it('reports an unwritable deployment without a dead-end write hint', () => {
    expect(describeLine(ref, { configured: false, writable: false }))
      .toBe('SOME_REF: not configured, and this deployment cannot store one')
  })

  it('names the supplying source when configured', () => {
    expect(describeLine(ref, { configured: true, source: 'file', writable: true }))
      .toBe('SOME_REF: configured from file')
  })

  it('warns that a stored value would be shadowed by a read-only source', () => {
    expect(describeLine(ref, { configured: true, source: 'env', writable: false }))
      .toBe('SOME_REF: configured read-only from env; storing a value would be shadowed by it')
  })
})

describe('/credential human command', () => {
  it('returns the usage error for a bare invocation', async () => {
    const test = await harness()
    const result = await run(test)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /credential <REF> [<value>]')
  })

  it('describes an unconfigured reference with the write command named', async () => {
    const test = await harness()
    await expect(run(test, ' DEEPSEEK_API_KEY')).resolves.toEqual({
      kind: 'success',
      text: 'DEEPSEEK_API_KEY: not configured; store a value with /credential DEEPSEEK_API_KEY <value>',
    })
  })

  it('stores one value through the credentials service and resolves it back', async () => {
    const test = await harness()
    await expect(run(test, ' DEEPSEEK_API_KEY sk-stored-test-key')).resolves.toEqual({
      kind: 'success',
      text: 'Stored DEEPSEEK_API_KEY; the next request resolves it.',
    })
    expect(await test.ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')))
      .toEqual({ value: 'sk-stored-test-key', source: 'file' })
    expect(await readFile(test.storePath, 'utf8')).toContain('DEEPSEEK_API_KEY: sk-stored-test-key')
  })

  it('keeps inner whitespace of a stored value', async () => {
    const test = await harness()
    await run(test, ' MULTI_TOKEN_REF  spaced value ')
    expect(await test.ctx.credentials.resolve(credentialRef('MULTI_TOKEN_REF')))
      .toEqual({ value: 'spaced value', source: 'file' })
  })

  it('describes a stored reference by its source', async () => {
    const test = await harness()
    await run(test, ' DEEPSEEK_API_KEY sk-stored-test-key')
    await expect(run(test, ' DEEPSEEK_API_KEY')).resolves.toEqual({
      kind: 'success',
      text: 'DEEPSEEK_API_KEY: configured from file',
    })
  })

  it('reports a read-only reference as shadowed instead of a silent no-op write', async () => {
    const test = await harness()
    vi.stubEnv('SHADOWED_REF', 'env-value')
    await expect(run(test, ' SHADOWED_REF')).resolves.toEqual({
      kind: 'success',
      text: 'SHADOWED_REF: configured read-only from env; storing a value would be shadowed by it',
    })
    const result = await run(test, ' SHADOWED_REF attempted-value')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('supplied read-only by the launching environment')
    expect(result.text).toContain('shadowed')
    expect(result.text).not.toContain('attempted-value')
    expect(await test.ctx.credentials.resolve(credentialRef('SHADOWED_REF')))
      .toEqual({ value: 'env-value', source: 'env' })
  })

  it('rejects a malformed reference without touching the store', async () => {
    const test = await harness()
    const result = await run(test, ' not-a-ref! some-value')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('credential ref "not-a-ref!" must match')
    expect(result.text).not.toContain('some-value')
  })

  it('never logs the secret: no event, result, or rendered text carries it', async () => {
    const test = await harness()
    const SECRET = 'sk-never-logged-9f8e7d6c'
    const result = await run(test, ` DEEPSEEK_API_KEY ${SECRET}`)
    expect(result.kind).toBe('success')
    expect(result.text).not.toContain(SECRET)
    const commandRun = test.session.events.find(event => event.type === 'command/run')
    expect(commandRun?.type === 'command/run' && Object.hasOwn(commandRun.data, 'args')).toBe(false)
    expect(JSON.stringify(test.session.events)).not.toContain(SECRET)
    // Command lifecycle stays log-only: nothing reaches the model surface.
    expect(test.session.deriveMessages()).toEqual([])
  })

  it('redacts a provider failure that carries the value', async () => {
    class LeakyProvider extends CredentialProvider {
      override async resolve(): Promise<ResolvedCredential | undefined> { return undefined }
      override async describe(): Promise<CredentialInfo> { return { configured: false, writable: true } }
      override async set(ref: CredentialRef, value: string): Promise<void> {
        throw new Error(`provider refused ${ref} with ${value} for storage`)
      }
      override async unset(): Promise<void> {}
    }
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const provider = ctx.plugin(LeakyProvider)
    cleanups.push(async () => { await provider.dispose() })
    await provider
    await ctx.plugin(commandCredential)
    const { agent, session } = stubAgent(ctx, 'leaky')
    ctx.agents.register(agent)
    const SECRET = 'sk-leaky-value-12345'
    const settled = await ctx.commands.execute(agent, `/credential SOME_REF ${SECRET}`, new AbortController().signal)
    expect(settled?.result).toEqual({
      kind: 'error',
      text: 'provider refused SOME_REF with <redacted> for storage',
    })
    expect(JSON.stringify(session.events)).not.toContain(SECRET)
  })
})
