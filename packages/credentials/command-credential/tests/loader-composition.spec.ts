import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as CommandCredential from '@deepseek-ai/dsh-command-credential'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Register one idle agent over a store-owned session, as an app's spine does. */
function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('credential-loader-agent')
  const session = ctx.sessions.create(id)
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const value: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: scope.ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

describe('/credential real Loader composition through cordis.yml', () => {
  it('boots cordis.yml, stores through the managed document, and logs no secret', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-credential-loader-'))
    vi.stubEnv('DSH_HOME', root)
    const configPath = join(root, 'cordis.yml')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-credentials-local'",
      "- name: '@deepseek-ai/dsh-command-credential'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
      ['@deepseek-ai/dsh-command-credential', CommandCredential],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context)
    const signal = new AbortController().signal

    // Discoverable through the composed registry, as a UI adapter finds it.
    expect(context.commands.list(owner).map(command => command.name)).toContain('credential')

    const SECRET = 'sk-loader-composition-secret'
    const stored = await context.commands.execute(owner, `/credential LOADER_KEY ${SECRET}`, signal)
    expect(stored?.result).toEqual({
      kind: 'success',
      text: 'Stored LOADER_KEY; the next request resolves it.',
    })

    // The write went through the service into the managed document — the
    // default path under the stubbed harness home — not into any `.env`.
    const document = await readFile(join(root, '.credentials.yaml'), 'utf8')
    expect(document).toContain(`LOADER_KEY: ${SECRET}`)

    const described = await context.commands.execute(owner, '/credential LOADER_KEY', signal)
    expect(described?.result).toEqual({
      kind: 'success',
      text: 'LOADER_KEY: configured from file',
    })

    // The secret never reaches the log: no `command/run` args, no done text,
    // nothing a model request could derive.
    const run = owner.session.events.find(event => event.type === 'command/run')
    expect(run?.type === 'command/run' && Object.hasOwn(run.data, 'args')).toBe(false)
    expect(JSON.stringify(owner.session.events)).not.toContain(SECRET)
    expect(owner.session.deriveMessages()).toEqual([])
  })
})
