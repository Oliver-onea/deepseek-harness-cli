import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'

import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SubagentRuntime, { type SubagentResult, type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

class FakeTransport implements JsonRpcTransportPeer {
  notifications: { method: string; params?: Record<string, unknown> }[] = []
  /** Server→client requests the transport carried, in order. */
  serverRequests: { method: string; params: Record<string, unknown>; signal: AbortSignal | undefined }[] = []
  /** Scripted answers, one per expected server→client request, in order. */
  serverAnswers: unknown[] = []

  async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    this.serverRequests.push({ method, params: params as Record<string, unknown>, signal })
    if (signal?.aborted) throw new Error('aborted')
    const answer = this.serverAnswers.shift()
    if (answer === undefined) throw new Error(`the SDK server sent an unscripted client request: ${method}`)
    if (answer instanceof Error) throw answer
    return answer
  }

  notify(method: string, params?: object): void {
    this.notifications.push(params === undefined ? { method } : { method, params: params as Record<string, unknown> })
  }
}

const servers: Server[] = []

/** The `turn/end` reason kinds a FakeTransport observed, in notification order. */
function turnEndReasons(transport: FakeTransport): string[] {
  return transport.notifications
    .filter(n => n.method === 'session.event' && (n.params?.event as { type?: string } | undefined)?.type === 'turn/end')
    .map(n => (n.params?.event as { data: { reason: { kind: string } } }).data.reason.kind)
}

/** Count cancel-driven inbox discards (splices logged with `outcome: 'canceled'`). */
function canceledSpliceCount(transport: FakeTransport): number {
  return transport.notifications.filter((n) => {
    if (n.method !== 'session.event') return false
    const event = n.params?.event as { type?: string; data?: { outcome?: string } } | undefined
    return event?.type === 'agent/inbox/spliced' && event.data?.outcome === 'canceled'
  }).length
}

/** Drain asynchronous work before a negative assertion. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function mockCompletionServer(): Promise<{ url: string; requests: unknown[]; headers: IncomingMessage['headers'][] }> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

/** SSE endpoint whose FIRST request streams one chunk then hangs until the client aborts; later requests complete. */
async function mockHangingFirstCompletionServer(): Promise<{ url: string; requests: { body: unknown; headers: IncomingMessage['headers'] }[] }> {
  const requests: { body: unknown; headers: IncomingMessage['headers'] }[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({ body: JSON.parse(body), headers: request.headers })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      if (requests.length === 1) {
        // The first turn stays in flight; the adapter's abort (or harness
        // disposal) destroys the socket, which is what ends this response.
        return
      }
      response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

/** Whether the observed stream logged the `next-step` inbox splice carrying the steering text. */
function hasSteerReceipt(transport: FakeTransport, text: string): boolean {
  return transport.notifications.some((n) => {
    if (n.method !== 'session.event') return false
    const event = n.params?.event as
      | { type?: string; data?: { target?: string; inserted?: unknown[] } }
      | undefined
    if (event?.type !== 'agent/inbox/spliced' || event.data?.target !== 'next-step') return false
    return JSON.stringify(event.data.inserted ?? []).includes(text)
  })
}

/** SSE endpoint whose FIRST request holds after its first chunk until `release()`; later requests complete. */
async function mockGatedFirstCompletionServer(): Promise<{ url: string; requests: unknown[]; release(): void }> {
  const requests: unknown[] = []
  let releaseFirst!: () => void
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      const finish = (): void => {
        response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
        response.write('data: [DONE]\n\n')
        response.end()
      }
      // The first turn parks mid-stream until the test steers, giving the
      // steering message a deterministic window before the step completes.
      if (requests.length === 1) {
        void gate.then(finish)
        return
      }
      finish()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, release: releaseFirst }
}

async function makeHarness(storageDir: string) {
  const ctx = new Context()
  await ctx.plugin(agentCore, { workspaceContext: false })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

/** Drive the owning service so test lifecycle events carry the real parent scope. */
async function settleSubagent(
  ctx: Context,
  parent: Agent,
  info: Omit<SubagentRunEndInfo, 'runId' | 'local'> & { localAgent: Agent | undefined },
  beforeSettle?: () => Promise<void>,
): Promise<void> {
  const result = Promise.withResolvers<SubagentResult>()
  const disposeProvider = ctx.subagents.registerProvider({
    name: info.provider,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start() {
      return {
        id: info.id,
        localAgent: info.localAgent,
        result: result.promise,
        dispose: () => Promise.resolve(),
      }
    },
  })
  try {
    const run = await ctx.subagents.start(info.provider, {
      parent,
      prompt: [],
      signal: new AbortController().signal,
    })
    await beforeSettle?.()
    if (info.lastAssistantMessage === undefined) {
      result.reject(new Error('synthetic infrastructure failure'))
    } else {
      result.resolve({ output: info.lastAssistantMessage, stopReason: info.stopReason })
    }
    await run.result.then(() => undefined, () => undefined)
    await run.dispose()
  } finally {
    disposeProvider()
  }
}

describe('HarnessSdkJsonRpcServer', () => {
  it('creates a harness agent and calls the configured OpenAI-compatible endpoint', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const init = await server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'dsagent-model',
        maxTokens: 321,
      }) as { serverInfo: { name: string } }
      expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

      const receipt = await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'fix it' }],
      })
      expect((receipt as { messageId?: unknown }).messageId).toBeTypeOf('string')

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      const body = llmServer.requests[0] as { model: string; messages: { role: string }[]; max_tokens?: number }
      expect(body.model).toBe('dsagent-model')
      expect(body.max_tokens).toBe(321)
      expect(body.messages[0]?.role).toBe('system')
      expect(body.messages.at(-1)?.role).toBe('user')
      expect(llmServer.headers[0]?.authorization).toBe('Bearer test-key')
      expect(transport.notifications.some(n => n.method === 'session.event')).toBe(true)
      await vi.waitFor(() => {
        expect(transport.notifications.findLast(n => n.method === 'session.status')).toEqual({
          method: 'session.status',
          params: { sessionId: 'main', status: 'idle' },
        })
      })

      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'again' }],
      })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(2) })

      const orphanHandle = await ctx.agents.create({
        sessionId: SessionId('orphan-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'dsagent-model' },
      })
      orphanHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'outside the sdk session map' }], source: { kind: 'user' } }))
      await orphanHandle.agent.whenIdle()
      await orphanHandle.dispose()
      expect(llmServer.requests).toHaveLength(3)

      await server.handleRequest('shutdown', undefined)
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('queues overlapping prompts for one session without blocking other sessions', async () => {
    const mainFollowup = vi.fn<Agent['followup']>()
    const mainAgent = ({
      id: SessionId('main'),
      followup: mainFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const otherFollowup = vi.fn<Agent['followup']>()
    const otherAgent = ({
      id: SessionId('other'),
      followup: otherFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const mainHandle = { agent: mainAgent, dispose: vi.fn(() => Promise.resolve()) }
    const otherHandle = { agent: otherAgent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn(async (options: { sessionId: SessionId }) =>
      String(options.sessionId) === 'main' ? mainHandle : otherHandle)
    const liveAgents = new Map<string, Agent>([['main', mainAgent], ['other', otherAgent]])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: (id: SessionId) => liveAgents.get(String(id)) },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    const prompt = (sessionId: string, text: string) => server.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('main', 'first')).messageId).toBeTypeOf('string')
    expect((await prompt('main', 'overlap')).messageId).toBeTypeOf('string')
    expect((await prompt('other', 'independent')).messageId).toBeTypeOf('string')

    expect(mainFollowup).toHaveBeenCalledTimes(2)
    expect(otherFollowup).toHaveBeenCalledOnce()
    await server.shutdown()
    expect(mainHandle.dispose).toHaveBeenCalledOnce()
    expect(otherHandle.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a prompt for a session whose agent was disposed outside the server', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({
      id: SessionId('zombie'),
      followup,
      whenIdle: vi.fn(() => Promise.resolve()),
    } satisfies Pick<Agent, 'id' | 'followup' | 'whenIdle'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    // The registry drops the agent after creation, modelling an agent-loop-only
    // reload that leaves the server's SessionRecord pointing at a detached agent.
    let live = true
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: (id: SessionId) => (live && String(id) === 'zombie' ? agent : undefined),
      },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    const prompt = (text: string) => server.prompt({
      sessionId: 'zombie',
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('while live')).messageId).toBeTypeOf('string')
    live = false
    await expect(prompt('after detach')).rejects.toThrow('session agent was disposed outside the server: zombie')
    // The detached agent was never driven by the rejected prompt.
    expect(followup).toHaveBeenCalledOnce()
    await server.shutdown()
  })

  it('aborts the active turn and clears queued work by default', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-interrupt-'))
    const llmServer = await mockHangingFirstCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' })

      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      // Queued behind the hung turn; the default interrupt splices it out
      // before its response settles.
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'queued' }] })

      await expect(server.handleRequest('session/interrupt', { sessionId: 'main' })).resolves.toEqual({})

      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['aborted']) })
      await vi.waitFor(() => {
        expect(transport.notifications.findLast(n => n.method === 'session.status')).toEqual({
          method: 'session.status',
          params: { sessionId: 'main', status: 'idle' },
        })
      })
      // The clear is durable: the queued prompt was discarded by a canceled splice.
      expect(canceledSpliceCount(transport)).toBe(1)
      // The cleared prompt never became a turn or a model request.
      await settle()
      expect(transport.notifications.filter(n =>
        n.method === 'session.event' && (n.params?.event as { type?: string }).type === 'turn/start')).toHaveLength(1)
      expect(llmServer.requests).toHaveLength(1)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('parks queued work across the abort when keepInbox is set', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-interrupt-keep-'))
    const llmServer = await mockHangingFirstCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' })

      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'queued' }] })

      await expect(server.handleRequest('session/interrupt', { sessionId: 'main', keepInbox: true }))
        .resolves.toEqual({})

      // Preserved work is NOT discarded and does not start a turn by itself:
      // it stays parked until a later waking prompt claims it.
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['aborted']) })
      expect(canceledSpliceCount(transport)).toBe(0)
      await settle()
      expect(llmServer.requests).toHaveLength(1)

      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'third' }] })
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['aborted', 'completed', 'completed']) })
      expect(llmServer.requests).toHaveLength(3)
      const second = llmServer.requests[1]?.body as { messages: unknown[] }
      expect(JSON.stringify(second.messages.at(-1))).toContain('queued')
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('accepts an interrupt on an idle session without arming later work', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-interrupt-idle-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' })

      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['completed']) })

      await expect(server.handleRequest('session/interrupt', { sessionId: 'main' })).resolves.toEqual({})

      // The no-op armed nothing: the next prompt runs its own ordinary turn.
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'second' }] })
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['completed', 'completed']) })
      expect(llmServer.requests).toHaveLength(2)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('validates interrupt params at the wire boundary and fails loud on unknown sessions', async () => {
    const cancel = vi.fn<Agent['cancel']>()
    const followup = vi.fn<Agent['followup']>()
    const agent = ({
      id: SessionId('main'),
      followup,
      cancel,
    } satisfies Pick<Agent, 'id' | 'followup' | 'cancel'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const liveAgents = new Map<string, Agent>([['main', agent]])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: (id: SessionId) => liveAgents.get(String(id)),
      },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'seed' }] })

    // Malformed params and unknown ids never reach the agent.
    await expect(server.handleRequest('session/interrupt', {}))
      .rejects.toThrow('session/interrupt sessionId must be a string')
    await expect(server.handleRequest('session/interrupt', { sessionId: 7 }))
      .rejects.toThrow('session/interrupt sessionId must be a string')
    await expect(server.handleRequest('session/interrupt', { sessionId: 'main', keepInbox: 'yes' }))
      .rejects.toThrow('session/interrupt keepInbox must be a boolean when given')
    await expect(server.handleRequest('session/interrupt', { sessionId: 'missing' }))
      .rejects.toThrow('unknown SDK session for session/interrupt: missing')
    expect(cancel).not.toHaveBeenCalled()

    expect(await server.handleRequest('session/interrupt', { sessionId: 'main' })).toEqual({})
    expect(cancel).toHaveBeenLastCalledWith({ kind: 'user' }, { keepInbox: undefined })
    expect(await server.handleRequest('session/interrupt', { sessionId: 'main', keepInbox: true })).toEqual({})
    expect(cancel).toHaveBeenLastCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(cancel).toHaveBeenCalledTimes(2)
    await server.shutdown()
  })

  it('joins a steering message into the running turn at its next step boundary', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-steer-'))
    const llmServer = await mockGatedFirstCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' })

      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      // The first request parks mid-stream; the steer lands inside the turn.
      const steer = await server.handleRequest('session/steer', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'prioritize tests' }],
      })
      expect(typeof (steer as { messageId: unknown }).messageId).toBe('string')
      await vi.waitFor(() => { expect(hasSteerReceipt(transport, 'prioritize tests')).toBe(true) })
      llmServer.release()

      // Fresh steering extends the turn one more step, so the second model
      // request carries the steering message and the turn completes once.
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['completed']) })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(2) })
      const second = llmServer.requests[1] as { messages: unknown[] }
      expect(JSON.stringify(second.messages)).toContain('prioritize tests')
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('opens the next turn when steering an idle session', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-steer-idle-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' })

      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['completed']) })

      // An idle steer is `Agent.steer`'s wakeup: it opens the next turn itself.
      const steered = await server.handleRequest('session/steer', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'follow-up course' }],
      })
      expect(typeof (steered as { messageId: unknown }).messageId).toBe('string')
      await vi.waitFor(() => { expect(turnEndReasons(transport)).toEqual(['completed', 'completed']) })
      expect(llmServer.requests).toHaveLength(2)
      const second = llmServer.requests[1] as { messages: unknown[] }
      expect(JSON.stringify(second.messages)).toContain('follow-up course')
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('validates steer params at the wire boundary and fails loud on unknown sessions', async () => {
    const steer = vi.fn<Agent['steer']>()
    const followup = vi.fn<Agent['followup']>()
    const agent = ({
      id: SessionId('main'),
      followup,
      steer,
    } satisfies Pick<Agent, 'id' | 'followup' | 'steer'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const liveAgents = new Map<string, Agent>([['main', agent]])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: (id: SessionId) => liveAgents.get(String(id)),
      },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'seed' }] })

    // Malformed params and unknown ids never reach the agent, and a steer
    // never creates the session.
    await expect(server.handleRequest('session/steer', {}))
      .rejects.toThrow('session/steer sessionId must be a string')
    await expect(server.handleRequest('session/steer', { sessionId: 7 }))
      .rejects.toThrow('session/steer sessionId must be a string')
    await expect(server.handleRequest('session/steer', { sessionId: 'missing', contentBlocks: [] }))
      .rejects.toThrow('unknown SDK session for session/steer: missing')
    expect(steer).not.toHaveBeenCalled()

    const result = await server.handleRequest('session/steer', {
      sessionId: 'main',
      contentBlocks: [{ type: 'text', text: 'course' }],
    })
    expect(typeof (result as { messageId: unknown }).messageId).toBe('string')
    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer.mock.calls[0]?.[0].content).toEqual([{ type: 'text', text: 'course' }])
    await server.shutdown()
  })

  it('routes approval questions for its own agents to the client and maps the answer', async () => {
    const steer = vi.fn<Agent['steer']>()
    const followup = vi.fn<Agent['followup']>()
    const agent = {
      id: SessionId('main'),
      session: { id: SessionId('main') },
      followup,
      steer,
    } as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const on = vi.fn((_event: string, _listener: unknown) => () => undefined)
    const ctx = {
      on,
      agents: { create: vi.fn(async () => handle), get: () => handle.agent },
      get: () => undefined,
    } as unknown as Context
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'seed' }] })
    const registration = (on.mock.calls as unknown as [string, unknown][]).find(([event]) => event === 'approval/request')
    if (registration === undefined) throw new Error('the server registered no approval answerer')
    const answerer = registration[1] as (req: { agent: Agent; toolName: string; callId?: string; reason?: string }, next: () => Promise<'unavailable'>) => Promise<'allowed-once' | 'rejected' | 'unavailable'>

    // An owned agent's question reaches the client with the audit facts.
    transport.serverAnswers.push(Promise.resolve({ outcome: 'allowed-once' }))
    await expect(answerer(
      { agent, toolName: 'bash', callId: 'call_1', reason: 'escalation requested' },
      () => Promise.resolve('unavailable'),
    )).resolves.toBe('allowed-once')
    expect(transport.serverRequests).toEqual([{
      method: 'approval/request',
      params: { sessionId: 'main', toolName: 'bash', callId: 'call_1', reason: 'escalation requested' },
      signal: undefined,
    }])

    // Any other answer fails closed; a client error rejects to the approval
    // service's containment.
    transport.serverAnswers.push(Promise.resolve({ outcome: 'rejected' }))
    await expect(answerer({ agent, toolName: 'bash' }, () => Promise.resolve('unavailable'))).resolves.toBe('rejected')
    transport.serverAnswers.push(Promise.resolve({}))
    await expect(answerer({ agent, toolName: 'bash' }, () => Promise.resolve('unavailable'))).resolves.toBe('rejected')
    transport.serverAnswers.push(new Error('client answered nothing'))
    await expect(answerer({ agent, toolName: 'bash' }, () => Promise.resolve('unavailable'))).rejects.toThrow('client answered nothing')

    // A question for an agent this server does not own delegates down the chain.
    const other = { id: SessionId('other'), session: { id: SessionId('other') } } as unknown as Agent
    await expect(answerer({ agent: other, toolName: 'bash' }, () => Promise.resolve('unavailable')))
      .resolves.toBe('unavailable')
    expect(transport.serverRequests).toHaveLength(4)
    await server.shutdown()
  })

  it('forwards whole-agent status without attributing a turn outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const session = ctx.sessions.create(SessionId('message-outcome'))
    const agent = ({
      id: SessionId('message-outcome'),
      session,
    } satisfies Pick<Agent, 'id' | 'session'>) as Agent

    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/status', { agent, status: 'idle' })

    expect(transport.notifications.filter(notification => notification.method === 'session.status'))
      .toEqual([
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'running' } },
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'idle' } },
      ])
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('notifies the host when a child session is created with parent lineage', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      ctx.sessions.create(SessionId('root-session'), {
        meta: { cwd: storageDir },
      })
      ctx.sessions.create(SessionId('child-session'), {
        meta: { cwd: storageDir, parentSession: SessionId('main') },
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.started',
        params: {
          parentSessionId: 'main',
          childSessionId: 'child-session',
        },
      })

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('creates an SDK session without an optional system prompt', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-no-system-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'plain-model' })
      await server.prompt({
        sessionId: 'plain',
        contentBlocks: [{ type: 'text', text: 'hello' }],
      })

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('notifies the host when a subagent run settles', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-end-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('main'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      // A custom in-process provider may own its child at the provider/root
      // scope while preserving durable parent lineage.
      const handle = await ctx.agents.create({
        sessionId: SessionId('child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('main') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      expect(ctx.agents.roots()).toContain(handle.agent)
      const parentlessHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('parentless-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('child-session'),
        localAgent: handle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'child done' }],
      }, () => handle.dispose())
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('parentless-child-session'),
        localAgent: parentlessHandle.agent,
        stopReason: 'error',
      }, () => parentlessHandle.dispose())

      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'child-session',
          parentSessionId: 'main',
          childSessionId: 'child-session',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'child done' }],
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'parentless-child-session',
          parentSessionId: 'main',
          childSessionId: 'parentless-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('ignores a remote run id that collides with a local child of the same parent', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-remote-collision-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('collision-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const collidingChild = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('remote-run-id'),
        meta: { cwd: storageDir, parentSession: SessionId('collision-parent') },
        agentOptions: { model: 'deepseek-official' },
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'remote',
        id: SessionId('remote-run-id'),
        localAgent: undefined,
        stopReason: 'completed',
        lastAssistantMessage: [],
      })

      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.agentId === 'remote-run-id',
      )).toBe(false)

      await collidingChild.dispose()
      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('retains locality across continuation runs on one live child', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-continuation-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('continuation-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const childHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('continuation-child'),
        meta: { cwd: storageDir, parentSession: SessionId('continuation-parent') },
        agentOptions: { model: 'deepseek-official' },
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'first' }],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'second' }],
      }, () => childHandle.dispose())

      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'continuation-child',
      )).toHaveLength(2)

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('correlates reused local ids by parent scope when runs settle out of order', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const oldParent = await ctx.agents.create({
        sessionId: SessionId('old-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const oldChild = await oldParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('old-parent') },
        agentOptions: { model: 'deepseek-official' },
      })
      const first = Promise.withResolvers<SubagentResult>()
      const sameLifetime = Promise.withResolvers<SubagentResult>()
      const replacement = Promise.withResolvers<SubagentResult>()
      const results = [first.promise, sameLifetime.promise, replacement.promise]
      let starts = 0
      let currentLocalAgent = oldChild.agent
      const disposeProvider = ctx.subagents.registerProvider({
        name: 'reused',
        capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start() {
          const result = results[starts]
          starts += 1
          if (result === undefined) throw new Error('unexpected fourth reused-id run')
          return Promise.resolve({ id: SessionId('reused-child'), localAgent: currentLocalAgent, result, dispose: () => Promise.resolve() })
        },
      })

      const firstRun = await ctx.subagents.start('reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      const sameLifetimeRun = await ctx.subagents.start('reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      sameLifetime.resolve({ output: [{ type: 'text', text: 'same lifetime' }], stopReason: 'completed' })
      await sameLifetimeRun.result
      await oldChild.dispose()
      const newParent = await ctx.agents.create({
        sessionId: SessionId('new-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const newChild = await newParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('new-parent') },
        agentOptions: { model: 'deepseek-official' },
      })
      currentLocalAgent = newChild.agent
      const secondRun = await ctx.subagents.start('reused', {
        parent: newParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })

      replacement.resolve({ output: [{ type: 'text', text: 'new lifetime' }], stopReason: 'completed' })
      await secondRun.result
      first.resolve({ output: [{ type: 'text', text: 'old lifetime' }], stopReason: 'completed' })
      await firstRun.result
      await Promise.resolve()

      const finished = transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'reused-child',
      )
      expect(finished.map(notification => notification.params?.lastAssistantMessage)).toEqual([
        [{ type: 'text', text: 'same lifetime' }],
        [{ type: 'text', text: 'new lifetime' }],
        [{ type: 'text', text: 'old lifetime' }],
      ])
      expect(finished.map(notification => notification.params?.parentSessionId)).toEqual([
        'old-parent',
        'new-parent',
        'old-parent',
      ])

      await firstRun.dispose()
      await sameLifetimeRun.dispose()
      await secondRun.dispose()
      disposeProvider()
      await newChild.dispose()
      await oldParent.dispose()
      await newParent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps locality bound to the accepted run across provider re-registration', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-provider-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parent = await ctx.agents.create({
        sessionId: SessionId('provider-reuse-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const child = await parent.agent.ctx.agents.create({
        sessionId: SessionId('provider-reuse-child'),
        meta: { cwd: storageDir, parentSession: SessionId('provider-reuse-parent') },
        agentOptions: { model: 'deepseek-official' },
      })
      const localResult = Promise.withResolvers<SubagentResult>()
      const remoteResult = Promise.withResolvers<SubagentResult>()
      const unregisterLocal = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          localAgent: child.agent,
          result: localResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const localRun = await ctx.subagents.start('reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      unregisterLocal()

      const unregisterRemote = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          localAgent: undefined,
          result: remoteResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const remoteRun = await ctx.subagents.start('reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })

      remoteResult.resolve({ output: [{ type: 'text', text: 'remote' }], stopReason: 'completed' })
      await remoteRun.result
      await Promise.resolve()
      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.lastAssistantMessage !== undefined,
      )).toBe(false)

      await child.dispose()
      localResult.resolve({ output: [{ type: 'text', text: 'local' }], stopReason: 'completed' })
      await localRun.result
      await Promise.resolve()
      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'provider-reuse-child',
      )).toEqual([{
        method: 'subagent.finished',
        params: {
          provider: 'reused-provider',
          agentId: 'provider-reuse-child',
          parentSessionId: 'provider-reuse-parent',
          childSessionId: 'provider-reuse-child',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'local' }],
        },
      }])

      await localRun.dispose()
      await remoteRun.dispose()
      unregisterRemote()
      await parent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('uses the recorded local flag when start was missed and ignores remote runs', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-fallback-'))
    const ctx = await makeHarness(storageDir)
    let parentHandle: AgentHandle | undefined
    let handle: AgentHandle | undefined
    let failedHandle: AgentHandle | undefined
    try {
      parentHandle = await ctx.agents.create({
        sessionId: SessionId('fallback-parent'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      handle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('fallback-child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('fallback-parent') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      const fallbackChild = handle.agent
      failedHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('failed-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      const missedStartResult = Promise.withResolvers<SubagentResult>()
      const disposeMissedStartProvider = ctx.subagents.registerProvider({
        name: 'fork',
        capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: true,
        start: () => Promise.resolve({
          id: SessionId('fallback-child-session'),
          localAgent: fallbackChild,
          result: missedStartResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      // Start before the server subscribes. The terminal payload still carries
      // this run's exact local child without reconstructing it from ids.
      const missedStartRun = await ctx.subagents.start('fork', {
        parent: parentHandle.agent,
        prompt: [],
        signal: new AbortController().signal,
      })
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: true })

      missedStartResult.resolve({ output: [], stopReason: 'max-tokens' })
      await missedStartRun.result
      await Promise.resolve()
      await missedStartRun.dispose()
      disposeMissedStartProvider()
      // The server also missed this agent's creation but sees the exact child
      // on the run lifecycle payload.
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork-live-fallback',
        id: SessionId('fallback-child-session'),
        localAgent: fallbackChild,
        stopReason: 'completed',
        lastAssistantMessage: [],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('failed-child-session'),
        localAgent: failedHandle.agent,
        stopReason: 'error',
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('missing-child-agent'),
        localAgent: undefined,
        stopReason: 'error',
      })

      // A result without output omits lastAssistantMessage from the wire; it
      // never sends `[]`.
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'fallback-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'fallback-child-session',
          status: 'ok',
          stopReason: 'max-tokens',
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'failed-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'failed-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })
      expect(transport.notifications.some(n =>
        n.method === 'subagent.finished'
        && n.params?.agentId === 'missing-child-agent',
      )).toBe(false)

      await server.shutdown()
    } finally {
      await handle?.dispose()
      await failedHandle?.dispose()
      await parentHandle?.dispose()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not re-register an LLM adapter whose provider already has an owner', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-existing-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const inspect = server as unknown as { hasAdapterFor(provider: string): boolean }

      expect(inspect.hasAdapterFor('deepseek-official')).toBe(true)
      expect(inspect.hasAdapterFor('missing-provider')).toBe(false)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'preinstalled-model' })

      expect(ctx.get('llm')?.listProviders().filter(provider => provider.id === 'deepseek-official')).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects a missing non-DeepSeek provider when an LLM service already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-new-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'new-model' }))
        .rejects.toThrow('no adapter registered for provider "private"')

      expect(ctx.get('llm')?.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid initialize maxTokens %s at the wire boundary',
    async (maxTokens) => {
      const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-max-tokens-'))
      const ctx = await makeHarness(storageDir)
      try {
        const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
        await expect(server.initialize({
          cwd: storageDir,
          provider: 'deepseek-official',
          model: 'model',
          maxTokens,
        })).rejects.toThrow('initialize maxTokens must be a positive safe integer')
        await server.shutdown()
      } finally {
        await ctx.fiber.dispose()
        await rm(storageDir, { recursive: true, force: true })
      }
    },
  )

  it('reports no adapter when the LLM service is absent', async () => {
    const ctx = new Context()
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
        hasAdapterFor(model: string): boolean
        shutdown(): Promise<Record<string, never>>
      }

      expect(server.hasAdapterFor('missing-model')).toBe(false)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown JSON-RPC runtime methods', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unknown-'))
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.handleRequest('does/not/exist', {}))
        .rejects
        .toThrow('unknown DeepSeek Harness SDK runtime method: does/not/exist')

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent session creation and retries a failed creation', async () => {
    let resolveShared: ((handle: AgentHandle) => void) | undefined
    const sharedCreation = new Promise<AgentHandle>((resolve) => { resolveShared = resolve })
    const sharedHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const retryHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockReturnValueOnce(sharedCreation)
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(retryHandle)
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      getOrCreateSession(sessionId: string): Promise<{ handle: AgentHandle }>
      shutdown(): Promise<Record<string, never>>
    }

    const first = server.getOrCreateSession('shared')
    const second = server.getOrCreateSession('shared')
    expect(create).toHaveBeenCalledTimes(1)
    resolveShared?.(sharedHandle)
    const [firstRecord, secondRecord] = await Promise.all([first, second])
    expect(firstRecord).toBe(secondRecord)

    await expect(server.getOrCreateSession('retry')).rejects.toThrow('creation failed')
    await expect(server.getOrCreateSession('retry')).resolves.toMatchObject({ handle: retryHandle })
    expect(create).toHaveBeenCalledTimes(3)

    await server.shutdown()
    expect(sharedHandle.dispose).toHaveBeenCalledOnce()
    expect(retryHandle.dispose).toHaveBeenCalledOnce()
    await expect(server.getOrCreateSession('after-shutdown')).rejects.toThrow('SDK server is shutting down')
  })

  it('resolves a relative cwd before creating the session', async () => {
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockResolvedValue({ agent: {} as Agent, dispose: () => Promise.resolve() })
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => ({ listProviders: () => [{ id: 'mock', name: 'Mock' }] }),
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      initialize(params: { cwd: string; provider: string; model: string; maxTokens?: number }): Promise<unknown>
      getOrCreateSession(sessionId: string): Promise<unknown>
      shutdown(): Promise<Record<string, never>>
    }

    await server.initialize({ cwd: '.', provider: 'mock', model: 'model', maxTokens: 123 })
    await server.getOrCreateSession('relative')

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'mock', model: 'model', maxTokens: 123 },
    }))
    await server.shutdown()
  })

  it('settles every teardown and aggregates multiple failures', async () => {
    const firstDispose = vi.fn(() => { throw new Error('first teardown failed') })
    const secondDispose = vi.fn(() => Promise.reject(new Error('second teardown failed')))
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport()) as unknown as {
      sessions: Map<string, { handle: AgentHandle; lastTurnEnd: undefined; activePrompt: boolean }>
      shutdown(): Promise<Record<string, never>>
    }
    server.sessions.set('first', { handle: { agent: {} as Agent, dispose: firstDispose }, lastTurnEnd: undefined, activePrompt: false })
    server.sessions.set('second', { handle: { agent: {} as Agent, dispose: secondDispose }, lastTurnEnd: undefined, activePrompt: false })

    await expect(server.shutdown()).rejects.toThrow('SDK server teardown failed')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('continues teardown after a subscription disposer fails', async () => {
    let subscription = 0
    const listenerFailure = new Error('listener teardown failed')
    const on = vi.fn(() => {
      subscription += 1
      return subscription === 1 ? () => { throw listenerFailure } : () => undefined
    })
    const ctx = {
      on,
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server.shutdown()).rejects.toBe(listenerFailure)
    expect(on).toHaveBeenCalledTimes(5)
  })
})
