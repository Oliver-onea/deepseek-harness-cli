import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as jsonrpc from '../src/index.ts'

/**
 * Mount the real namespace plugin with in-memory stdio and exit hooks. Covers
 * the full transport/server path, response-before-exit shutdown exactly once,
 * and bare-fiber disposal without process exit.
 */

/** One ordered frame, write completion, or exit observation. */
type WireEvent =
  | { kind: 'frame'; frame: Record<string, unknown> }
  | { kind: 'write-complete'; ids: (string | number)[] }
  | { kind: 'root-disposed' }
  | { kind: 'exit'; code: number }

interface ApplyHarness {
  ctx: Context
  /** The plugin fiber used by the bare-dispose case. */
  fiber: Awaited<ReturnType<Context['plugin']>>
  /** Frames, write completions, and exits in observation order. */
  events: WireEvent[]
  outputErrors: Error[]
  send(frame: Record<string, unknown>): void
  sendRaw(text: string): void
  frames(): Record<string, unknown>[]
  exits(): number[]
  waitForFrame(predicate: (frame: Record<string, unknown>) => boolean, description: string): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

/** Poll asynchronous output for up to five seconds. */
async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Drain asynchronous work before a negative assertion. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

/** Mount the real plugin on a minimal harness with in-memory stdio and exit. */
async function mountPlugin(
  storageDir: string,
  options: { writeDelayMs?: number; failFlush?: boolean } = {},
): Promise<ApplyHarness> {
  const ctx = new Context()
  await ctx.plugin(agentCore, { workspaceContext: false })
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))

  const input = new PassThrough()
  const events: WireEvent[] = []
  const outputErrors: Error[] = []
  let pendingOutput = ''
  // Record frame admission separately from write completion so delayed output
  // tests the flush barrier.
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const ids: (string | number)[] = []
      pendingOutput += chunk.toString('utf8')
      for (;;) {
        const newline = pendingOutput.indexOf('\n')
        if (newline < 0) break
        const line = pendingOutput.slice(0, newline).trim()
        pendingOutput = pendingOutput.slice(newline + 1)
        if (line) {
          const frame = JSON.parse(line) as Record<string, unknown>
          events.push({ kind: 'frame', frame })
          if (typeof frame.id === 'string' || typeof frame.id === 'number') ids.push(frame.id)
        }
      }
      const complete = (): void => {
        if (options.failFlush === true && chunk.length === 0) {
          callback(new Error('flush callback failed'))
          return
        }
        events.push({ kind: 'write-complete', ids })
        callback()
      }
      if ((options.writeDelayMs ?? 0) > 0) setTimeout(complete, options.writeDelayMs)
      else complete()
    },
  })
  output.on('error', (error: Error) => { outputErrors.push(error) })
  const exit = (code: number): void => { events.push({ kind: 'exit', code }) }

  ctx.effect(() => () => { events.push({ kind: 'root-disposed' }) }, 'jsonrpc test root-disposal witness')
  const fiber = await ctx.plugin(jsonrpc, { input, output, exit })

  const frames = (): Record<string, unknown>[] =>
    events.flatMap(event => event.kind === 'frame' ? [event.frame] : [])
  return {
    ctx,
    fiber,
    events,
    outputErrors,
    send: (frame) => { input.write(`${JSON.stringify(frame)}\n`) },
    sendRaw: (text) => { input.write(text) },
    frames,
    exits: () => events.flatMap(event => event.kind === 'exit' ? [event.code] : []),
    waitForFrame: (predicate, description) => waitFor(() => frames().find(predicate), description),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

/** Keyless SSE endpoint for completing a prompt turn. */
async function mockCompletionServer(): Promise<{ url: string; requests: unknown[] }> {
  const requests: unknown[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
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
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

/** SSE endpoint whose FIRST request streams one chunk then hangs; later requests complete. */
async function mockHangingFirstCompletionServer(): Promise<{ url: string; requests: unknown[] }> {
  const requests: unknown[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      // The first turn stays in flight so the approval ask lands inside an
      // open turn; harness disposal destroys the socket.
      if (requests.length === 1) return
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

describe('dsh-sdk-jsonrpc-server plugin apply', () => {
  it('serves initialize over the injected stdio pair', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-init-'))
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const harness = await mountPlugin(storageDir)
    try {
      harness.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'apply-model' } })

      const response = await harness.waitForFrame(frame => frame.id === 'init-1', 'initialize response')
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'init-1',
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } },
      })
      expect(harness.exits()).toEqual([])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('drives a session/prompt turn end-to-end and forwards session notifications as output frames', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-prompt-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const harness = await mountPlugin(storageDir)
    try {
      harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' } })
      await harness.waitForFrame(frame => frame.id === 1, 'initialize response')

      harness.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'fix it' }] },
      })
      const response = await harness.waitForFrame(frame => frame.id === 2, 'prompt response')
      expect((response.result as { messageId?: unknown }).messageId).toBeTypeOf('string')
      await harness.waitForFrame(
        frame => frame.method === 'session.status'
          && (frame.params as { status?: string } | undefined)?.status === 'idle',
        'idle session status',
      )

      expect(llmServer.requests).toHaveLength(1)
      const body = llmServer.requests[0] as { model: string; messages: { role: string }[] }
      expect(body.model).toBe('dsagent-model')
      expect(body.messages.at(-1)?.role).toBe('user')

      // Notifications use the same transport and arrive as id-less frames.
      const notifications = harness.frames().filter(frame => frame.id === undefined)
      expect(notifications.some(frame => frame.method === 'session.event')).toBe(true)
      expect(notifications.findLast(frame => frame.method === 'session.status')).toMatchObject({
        jsonrpc: '2.0',
        params: { sessionId: 'main', status: 'idle' },
      })
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('answers session/interrupt over the wire and errors on unknown sessions', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-interrupt-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const harness = await mountPlugin(storageDir)
    try {
      harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' } })
      await harness.waitForFrame(frame => frame.id === 1, 'initialize response')
      harness.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'fix it' }] },
      })
      await harness.waitForFrame(frame => frame.id === 2, 'prompt response')
      await harness.waitForFrame(
        frame => frame.method === 'session.status'
          && (frame.params as { status?: string } | undefined)?.status === 'idle',
        'idle session status',
      )

      // The settled session accepts the interrupt as a no-op.
      harness.send({ jsonrpc: '2.0', id: 3, method: 'session/interrupt', params: { sessionId: 'main' } })
      const interrupt = await harness.waitForFrame(frame => frame.id === 3, 'interrupt response')
      expect(interrupt).toEqual({ jsonrpc: '2.0', id: 3, result: {} })

      // An unknown session id fails loud and names the id.
      harness.send({ jsonrpc: '2.0', id: 4, method: 'session/interrupt', params: { sessionId: 'ghost' } })
      const unknown = await harness.waitForFrame(frame => frame.id === 4, 'unknown-session error response')
      expect(unknown).toEqual({
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32603, message: 'unknown SDK session for session/interrupt: ghost' },
      })
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('answers session/steer over the wire and errors on unknown sessions', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-steer-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const harness = await mountPlugin(storageDir)
    try {
      harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' } })
      await harness.waitForFrame(frame => frame.id === 1, 'initialize response')
      harness.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'fix it' }] },
      })
      await harness.waitForFrame(frame => frame.id === 2, 'prompt response')
      await harness.waitForFrame(
        frame => frame.method === 'session.status'
          && (frame.params as { status?: string } | undefined)?.status === 'idle',
        'idle session status',
      )

      // An idle steer is Agent.steer's wakeup: it opens the next turn itself.
      harness.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/steer',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'steered course' }] },
      })
      const steer = await harness.waitForFrame(frame => frame.id === 3, 'steer response')
      expect(typeof (steer.result as { messageId?: unknown }).messageId).toBe('string')
      await harness.waitForFrame(
        frame => frame.method === 'session.status'
          && (frame.params as { status?: string } | undefined)?.status === 'idle',
        'idle session status after the steered turn',
      )
      expect(llmServer.requests).toHaveLength(2)
      const second = llmServer.requests[1] as { messages: unknown[] }
      expect(JSON.stringify(second.messages)).toContain('steered course')

      // An unknown session id fails loud and names the id.
      harness.send({ jsonrpc: '2.0', id: 4, method: 'session/steer', params: { sessionId: 'ghost', contentBlocks: [] } })
      const unknown = await harness.waitForFrame(frame => frame.id === 4, 'unknown-session error response')
      expect(unknown).toEqual({
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32603, message: 'unknown SDK session for session/steer: ghost' },
      })
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('asks the wire client over approval/request and settles its decision', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-approval-'))
    const llmServer = await mockHangingFirstCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const harness = await mountPlugin(storageDir)
    await harness.ctx.plugin(UserApproval)
    try {
      harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' } })
      await harness.waitForFrame(frame => frame.id === 1, 'initialize response')
      harness.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'hang the turn open' }] },
      })
      await harness.waitForFrame(frame => frame.id === 2, 'prompt response')
      await waitFor(() => llmServer.requests.length > 0 ? llmServer.requests.length : undefined, 'first model request')

      // The turn hangs open, so the approval ask lands inside it. The ask
      // travels the real ApprovalService waterfall into the server's
      // answerer and out over the wire as a server→client request.
      const agent = harness.ctx.agents.get(SessionId('main'))
      if (agent === undefined) throw new Error('no live agent for session main')
      const decision = harness.ctx.approval.request({ agent, toolName: 'bash', reason: 'escalation requested' })
      const ask = await harness.waitForFrame(
        frame => frame.method === 'approval/request',
        'approval/request server-to-client request',
      )
      expect(ask.params).toMatchObject({ sessionId: 'main', toolName: 'bash', reason: 'escalation requested' })
      harness.send({ jsonrpc: '2.0', id: ask.id, result: { outcome: 'allowed-once' } })
      await expect(decision).resolves.toBe('allowed-once')

      // A second ask whose client answer is a rejection fails closed. The
      // frame poll matches only the NEW request id — waitForFrame finds the
      // first historical match.
      const second = harness.ctx.approval.request({ agent, toolName: 'bash' })
      const askTwo = await harness.waitForFrame(
        frame => frame.method === 'approval/request' && frame.id !== ask.id,
        'second approval/request',
      )
      harness.send({ jsonrpc: '2.0', id: askTwo.id, result: { outcome: 'rejected' } })
      await expect(second).resolves.toBe('rejected')
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('answers shutdown before exiting 0 exactly once, even against a racing second shutdown', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-shutdown-'))
    const harness = await mountPlugin(storageDir, { writeDelayMs: 10 })
    try {
      // One chunk makes the two deferred exit callbacks race.
      const first = { jsonrpc: '2.0', id: 'sd-1', method: 'shutdown' }
      const second = { jsonrpc: '2.0', id: 'sd-2', method: 'shutdown' }
      harness.sendRaw(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)

      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit recorder call')
      expect(harness.exits()).toEqual([0])

      // Both response writes and the flush barrier complete before exit.
      const exitIndex = harness.events.findIndex(event => event.kind === 'exit')
      const firstResponse = harness.events.findIndex(event => event.kind === 'frame' && event.frame.id === 'sd-1')
      const secondResponse = harness.events.findIndex(event => event.kind === 'frame' && event.frame.id === 'sd-2')
      const firstComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('sd-1'))
      const secondComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('sd-2'))
      const flushComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.length === 0)
      const rootDisposed = harness.events.findIndex(event => event.kind === 'root-disposed')
      expect(firstResponse).toBeGreaterThanOrEqual(0)
      expect(secondResponse).toBeGreaterThanOrEqual(0)
      expect(firstComplete).toBeGreaterThan(firstResponse)
      expect(secondComplete).toBeGreaterThan(secondResponse)
      expect(flushComplete).toBeGreaterThan(firstComplete)
      expect(flushComplete).toBeGreaterThan(secondComplete)
      expect(rootDisposed).toBeGreaterThan(flushComplete)
      expect(exitIndex).toBeGreaterThan(rootDisposed)

      await settle()
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'after-exit', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('still disposes and exits once when the flush callback fails', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-flush-failure-'))
    const harness = await mountPlugin(storageDir, { failFlush: true })
    try {
      harness.send({ jsonrpc: '2.0', id: 'sd-fail', method: 'shutdown' })

      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit after flush failure')
      await settle()
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
      expect(harness.outputErrors.map(error => error.message)).toEqual(['flush callback failed'])

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'after-flush-failure', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('stops serving on a bare fiber dispose (HMR-style unload) without calling exit', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-dispose-'))
    const harness = await mountPlugin(storageDir)
    try {
      // Prove the handler-rejection path is live before disposal.
      harness.send({ jsonrpc: '2.0', id: 'probe-1', method: 'nope/unknown' })
      const error = await harness.waitForFrame(frame => frame.id === 'probe-1', 'error response for unknown method')
      expect(error.error).toMatchObject({
        code: -32603,
        message: 'unknown DeepSeek Harness SDK runtime method: nope/unknown',
      })

      await harness.fiber.dispose()
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'probe-2', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
      expect(harness.exits()).toEqual([])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})
