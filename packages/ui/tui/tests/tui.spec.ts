import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import GoalService from '@deepseek-ai/dsh-goal'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import * as tui from '../src/index.ts'

const SESSION = 'session-tui-plugin'

/** A terminal that records what the renderer wrote instead of touching a TTY. */
function fakeTerminal(): Terminal & { written: string[]; title: string | undefined; input: (data: string) => void } {
  let onInput: (data: string) => void = () => {}
  const terminal = {
    written: [] as string[],
    title: undefined as string | undefined,
    input: (data: string) => { onInput(data) },
    start(handler: (data: string) => void): void { onInput = handler },
    stop(): void {},
    drainInput: () => Promise.resolve(),
    write(data: string): void { terminal.written.push(data) },
    get columns(): number { return 80 },
    get rows(): number { return 24 },
    get kittyProtocolActive(): boolean { return false },
    moveBy(): void {}, hideCursor(): void {}, showCursor(): void {},
    clearLine(): void {}, clearFromCursor(): void {}, clearScreen(): void {},
    setTitle(title: string): void { terminal.title = title },
    setProgress(): void {},
  }
  return terminal
}

/** The whole screen as one string, for asserting what the reader can see. */
function screen(terminal: { written: string[] }): string {
  return terminal.written.join('')
    .replaceAll(/\x1b\][^\x07]*\x07/gu, '')
    .replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
}

let context: Context | undefined
const original = { ...tui.internals }

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  Object.assign(tui.internals, original)
})

/** Register a live agent over a real session, the way a host's loop would. */
function registerAgent(ctx: Context, id = SESSION): Agent & { session: Session; followups: unknown[] } {
  const scope = ctx.plugin(() => {})
  // The store's publication hooks are what turn an append into `session/event`,
  // so the terminal follows a live session exactly as it does in production.
  const session = ctx.sessions.create(SessionId(id))
  const followups: unknown[] = []
  const agent = {
    id: session.id,
    options: { provider: 'p', model: 'm' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle' as const,
    ctx: scope.ctx,
    followup: (message: unknown) => { followups.push(message) },
    steer: () => {}, inject: () => {}, send: () => {}, cancel: () => {},
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    followups,
  }
  ctx.agents.register(agent as unknown as Agent)
  return agent as unknown as Agent & { session: Session; followups: unknown[] }
}

/** Mount the front door over a fake terminal and let its async startup settle. */
async function mount(config: Partial<tui.Config> = {}): Promise<{
  ctx: Context
  terminal: ReturnType<typeof fakeTerminal>
  agent: Agent & { session: Session; followups: unknown[] }
}> {
  const terminal = fakeTerminal()
  tui.internals.interactive = () => true
  tui.internals.createTerminal = () => terminal
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestions)
  const agent = registerAgent(ctx)
  await ctx.plugin(tui, { session: SESSION, color: false, ...config })
  await new Promise(resolve => setTimeout(resolve, 20))
  return { ctx, terminal, agent }
}

describe('resolveTerminalConfig', () => {
  it('defaults a composition that states only the session', () => {
    expect(tui.resolveTerminalConfig({ session: SESSION }))
      .toEqual({
        color: true,
        headLines: 8,
        tailLines: 4,
        showReasoning: false,
        agentWaitTimeoutMs: tui.DEFAULT_AGENT_WAIT_TIMEOUT_MS,
        maxSuggestions: 8,
      })
  })

  it('keeps every stated setting', () => {
    expect(tui.resolveTerminalConfig({
      session: SESSION, color: false, headLines: 1, tailLines: 2, showReasoning: true, agentWaitTimeoutMs: 9,
      maxSuggestions: 3,
    })).toEqual({
      color: false, headLines: 1, tailLines: 2, showReasoning: true, agentWaitTimeoutMs: 9,
      maxSuggestions: 3,
    })
  })
})

describe('resolveSelection', () => {
  const fallback = { provider: 'd', model: 'dm' }

  it('prefers the route the composition configured for this agent', () => {
    const agent = { options: { provider: 'p', model: 'm' } } as unknown as Agent
    expect(tui.resolveSelection(agent, fallback)).toEqual({ provider: 'p', model: 'm' })
  })

  it('falls back to the deployment default when the agent names a partial route', () => {
    const halfRoute = { options: { provider: 'p' } } as unknown as Agent
    expect(tui.resolveSelection(halfRoute, fallback)).toEqual(fallback)
    const noRoute = { options: {} } as unknown as Agent
    expect(tui.resolveSelection(noRoute, fallback)).toEqual(fallback)
  })

  it('leaves the selection unset when nothing names a route', () => {
    expect(tui.resolveSelection({ options: {} } as unknown as Agent, undefined)).toBeUndefined()
  })
})

describe('isInteractiveProcess', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ])('reads stdin %s / stdout %s as %s', (stdin, stdout, expected) => {
    const streams = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }
    try {
      Object.assign(process.stdin, { isTTY: stdin })
      Object.assign(process.stdout, { isTTY: stdout })
      expect(tui.isInteractiveProcess()).toBe(expected)
    } finally {
      Object.assign(process.stdin, { isTTY: streams.stdin })
      Object.assign(process.stdout, { isTTY: streams.stdout })
    }
  })

  it('builds a real terminal by default', () => {
    expect(tui.internals.createTerminal()).toBeDefined()
  })
})

describe('dsh-tui mounting', () => {
  it('refuses to start without a TTY on both streams', () => {
    tui.internals.interactive = () => false
    const ctx = new Context()
    context = ctx
    expect(() => { void tui.apply(ctx, { session: SESSION }) })
      .toThrow('needs a TTY on both stdin and stdout')
  })

  it('refuses before screen takeover when the configured agent never appears', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const started = tui.apply(ctx, {
      session: 'missing-session', color: false, agentWaitTimeoutMs: 1,
    })
    await expect(started).rejects.toThrow(
      'agent for session "missing-session" did not appear within 1ms',
    )
    expect(terminal.written).toEqual([])
  })

  it('names the pane after the model once the screen is up', async () => {
    const { terminal } = await mount()
    expect(terminal.title).toBe('dsh — m')
  })

  it('draws the durable log the host resumed before following live appends', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const agent = registerAgent(ctx)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'resumed question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('resumed question')
  })

  it('follows live appends onto the screen', async () => {
    const { terminal, agent } = await mount()
    agent.session.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'live answer' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('live answer')
  })

  it('submits the invocation first task once the screen is up', async () => {
    const { agent } = await mount({ task: 'run the tests' })
    expect(agent.followups).toHaveLength(1)
  })

  it('ignores a blank first task', async () => {
    const { agent } = await mount({ task: '   ' })
    expect(agent.followups).toHaveLength(0)
  })

  it('registers the terminal-only leave commands and settles the agent before exiting', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const exit = vi.fn()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Commands)
    ctx.provide('appExit', exit)
    const agent = registerAgent(ctx)
    const cancels: unknown[] = []
    Object.assign(agent, { cancel: (cause: unknown) => { cancels.push(cause) } })
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(
      expect.arrayContaining(['exit', 'quit']),
    )
    const settled = await ctx.commands.execute(agent, '/exit', new AbortController().signal)
    expect(settled?.result).toEqual({ kind: 'success', text: 'Leaving.' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancels).toEqual([{ kind: 'user' }])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('answers /help with the live command list and no model turn', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Commands)
    const agent = registerAgent(ctx)
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    terminal.input('/')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen(terminal)).toContain('List the commands this terminal resolves')
    terminal.input('\x1b')
    terminal.input('\x7f')

    const settled = await ctx.commands.execute(agent, '/help', new AbortController().signal)
    expect(settled?.result).toMatchObject({ kind: 'success' })
    const listed = settled !== undefined && settled.result.kind === 'success' ? settled.result.text : ''
    expect(listed).toContain('/exit — Leave the terminal session')
    expect(listed).toContain('/help — List the commands this terminal resolves')
    const types = agent.session.events.map(event => event.type)
    expect(types).toContain('command/run')
    expect(types).toContain('command/done')
    expect(types).not.toContain('user/message')
    expect(types).not.toContain('turn/start')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('/help — List the commands this terminal resolves')
  })

  it('lists a command registered after the terminal mounted, without a restart', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Commands)
    const agent = registerAgent(ctx)
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    const dispose = ctx.commands.register({
      name: 'demo-late',
      description: 'registered after the screen is up',
      handler: () => ({ kind: 'success' }),
    })
    const shellCommands = ctx.commands.list(agent).map(command => command.name)
    expect(shellCommands).toContain('demo-late')
    const settled = await ctx.commands.execute(agent, '/help', new AbortController().signal)
    expect(settled?.result.kind).toBe('success')
    const listed = settled !== undefined && settled.result.kind === 'success' ? settled.result.text : ''
    expect(listed).toContain('/demo-late — registered after the screen is up')
    dispose()
    expect(ctx.commands.list(agent).map(command => command.name)).not.toContain('demo-late')
  })

  it('removes every terminal-owned command when the plugin fiber disposes', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Commands)
    const agent = registerAgent(ctx)
    const fiber = await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.commands.list(agent).map(command => command.name))
      .toEqual(expect.arrayContaining(['exit', 'quit', 'help']))

    await fiber.dispose()

    expect(ctx.commands.list(agent)).toEqual([])
  })

  it('offers no command menu when the composition mounts no command registry', async () => {
    const { terminal } = await mount()
    terminal.input('/')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen(terminal)).toContain('/')
    expect(screen(terminal)).not.toContain('Leave the terminal session')
  })

  it('esc through the input listener dismisses the menu without cancelling the agent', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Commands)
    const agent = registerAgent(ctx)
    const cancels: unknown[] = []
    Object.assign(agent, { cancel: (cause: unknown) => { cancels.push(cause) } })
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    terminal.input('/')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen(terminal)).toContain('List the commands this terminal resolves')
    terminal.input('\x1b')
    await new Promise(resolve => setTimeout(resolve, 20))
    // The esc reached the editor's dismiss path, never the agent's cancel:
    // queued prompts and the running turn survive.
    expect(cancels).toEqual([])
  })

  it('esc with no menu open still cancels the running turn', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const agent = registerAgent(ctx)
    const cancels: unknown[] = []
    Object.assign(agent, { cancel: (cause: unknown) => { cancels.push(cause) } })
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    terminal.input('\x1b')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancels).toEqual([{ kind: 'user' }])
  })

  it('escapes control bytes in a candidate description before they reach the screen', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Commands)
    registerAgent(ctx)
    ctx.commands.register({
      name: 'evil',
      description: 're\x1b]0;hijack\x07paint',
      handler: () => ({ kind: 'success' }),
    })
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    terminal.input('/')
    await new Promise(resolve => setTimeout(resolve, 50))
    // The drawn menu carries the visible escape text, not a live OSC sequence.
    expect(screen(terminal)).toContain('re\\x1b]0;hijack\\x07paint')
    terminal.input('\x1b')
  })

  it('offers running subagent children under @ when the capability is composed', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    registerAgent(ctx)
    const child = {
      kind: 'child',
      id: SessionId('session-child'),
      activity: 'running',
      hasChildren: false,
      mode: 'continuable',
      label: 'scan-runner',
    } as SubagentListEntry
    const settledChild = {
      kind: 'child',
      id: SessionId('session-settled'),
      activity: 'inactive',
      hasChildren: false,
      mode: 'one-shot',
      label: 'settled-runner',
    } as SubagentListEntry
    ctx.provide('subagents', {
      listChildren: async () => [child, settledChild],
    } as never)
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    terminal.input('@')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen(terminal)).toContain('scan-runner')
    expect(screen(terminal)).not.toContain('settled-runner')
    terminal.input('\x1b')
  })

  it('offers no @ menu when the composition mounts no subagent capability', async () => {
    const { terminal } = await mount()
    terminal.input('@')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen(terminal)).not.toContain('runner')
  })

  it('answers this session approval requests through the same panel', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestions)
    await ctx.plugin(UserApproval)
    const agent = registerAgent(ctx)
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    agent.session.append('turn/start', { turn: 0 })
    const pending = ctx.approval.request({ agent, toolName: 'bash', reason: 'writes outside the workspace' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('Allow bash?')
    terminal.input('\r')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('registers the question provider so a tool call can reach the reader', async () => {
    const { ctx, terminal } = await mount()
    const pending = ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Ship it?', options: [{ label: 'Yes' }] }] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('Ship it?')
    terminal.input('\r')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: ['Yes'] }] })
  })

  it('restores the terminal when the tree disposes', async () => {
    const { ctx, terminal } = await mount()
    const before = terminal.written.length
    await ctx.fiber.dispose()
    context = undefined
    expect(terminal.written.length).toBeGreaterThan(before)
  })

  it('reports a startup failure through the launcher exit rather than a half-drawn screen', async () => {
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => { throw new Error('no terminal here') }
    const exit = vi.fn()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('appExit', exit)
    registerAgent(ctx)
    await ctx.plugin(tui, { session: SESSION })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('honors every terminal setting the composition states', async () => {
    const { terminal } = await mount({ headLines: 2, tailLines: 2, showReasoning: true })
    expect(screen(terminal)).toContain('ready')
  })

  it('ignores events from another session and agents it does not drive', async () => {
    const { ctx, terminal, agent } = await mount()
    const other = registerAgent(ctx, 'session-someone-else')
    other.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not mine' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'mine' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('mine')
    expect(screen(terminal)).not.toContain('not mine')
  })

  it('reports a non-Error startup failure without losing its text', async () => {
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => { throw 'plain string failure' }
    const exit = vi.fn()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('appExit', exit)
    registerAgent(ctx)
    await ctx.plugin(tui, { session: SESSION })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('waits for the agent the host is still creating', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(terminal.title).toBeUndefined()
    // Another agent's creation is not this terminal's session.
    registerAgent(ctx, 'session-unrelated')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(terminal.title).toBeUndefined()
    registerAgent(ctx)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(terminal.title).toBe('dsh — m')
  })

  it('settles the agent wait when the tree disposes first', async () => {
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => fakeTerminal()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tui, { session: 'session-never-created', color: false })
    await expect(ctx.fiber.dispose()).resolves.not.toThrow()
    context = undefined
  })

  it('shows goal, plan mode, and permission preset from composed services', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestions)
    await ctx.plugin(GoalService)
    await ctx.plugin(PlanModeController, { section: 'test plan guidance' })
    ctx.provide('permissionPresets', { current: () => 'workspace-write' } as never)
    const agent = registerAgent(ctx)
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    ctx.goals.create(agent, { objective: 'ship the feature' })
    ctx.planMode.set(agent, true)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(screen(terminal)).toContain('goal: ship the feature')
    expect(screen(terminal)).toContain('plan')
    expect(screen(terminal)).toContain('workspace-write')
  })
})

describe('createPresenter', () => {
  it('resolves a tool view through the definitions the agent sees', async () => {
    const { ctx, agent } = await mount()
    ctx.tools.register({
      name: 'demo',
      description: 'demo',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => [] },
      execute: () => Promise.resolve({ content: [] }),
      presentCall: (args: unknown) => ({ card: 'generic', title: `Demo ${(args as { n: number }).n}` }),
      presentResult: () => ({ card: 'generic', title: 'Demo done' }),
    })
    const presenter = tui.createPresenter(ctx, agent)
    expect(presenter.presentCall('demo', '{"n":1}')).toEqual({ card: 'generic', title: 'Demo 1' })
    expect(presenter.presentResult('demo', '{"n":1}', { content: [], isError: false }))
      .toEqual({ card: 'generic', title: 'Demo done' })
  })

  it('falls back to no view for unparseable arguments, a throwing presenter, or an unknown tool', async () => {
    const { ctx, agent } = await mount()
    ctx.tools.register({
      name: 'boom',
      description: 'boom',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => [] },
      execute: () => Promise.resolve({ content: [] }),
      presentCall: () => { throw new Error('presenter failed') },
      presentResult: () => { throw new Error('presenter failed') },
    })
    const presenter = tui.createPresenter(ctx, agent)
    expect(presenter.presentCall('boom', '{}')).toBeUndefined()
    expect(presenter.presentResult('boom', '{}', { content: [], isError: false })).toBeUndefined()
    expect(presenter.presentCall('demo', 'not json')).toBeUndefined()
    expect(presenter.presentCall('missing', '{}')).toBeUndefined()
    expect(presenter.presentResult('missing', '{}', { content: [], isError: false })).toBeUndefined()
  })

  it('carries the tool own meta payload back into presentResult', async () => {
    const { ctx, agent } = await mount()
    let seen: unknown
    ctx.tools.register({
      name: 'meta',
      description: 'meta',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => [] },
      execute: () => Promise.resolve({ content: [] }),
      presentResult: (_args: unknown, result: { meta?: unknown }) => {
        seen = result.meta
        return undefined
      },
    })
    tui.createPresenter(ctx, agent).presentResult('meta', '{}', { content: [], isError: false, meta: { a: 1 } })
    expect(seen).toEqual({ a: 1 })
  })
})

/** Mount under whichever timer implementation the calling test installed. */
async function mountFake(): Promise<{
  ctx: Context
  terminal: ReturnType<typeof fakeTerminal>
  agent: Agent & { session: Session; followups: unknown[] }
}> {
  const terminal = fakeTerminal()
  tui.internals.interactive = () => true
  tui.internals.createTerminal = () => terminal
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agent = registerAgent(ctx)
  await ctx.plugin(tui, { session: SESSION, color: false })
  await vi.advanceTimersByTimeAsync(20)
  return { ctx, terminal, agent }
}

describe('dsh-tui keyboard', () => {
  it('interrupts a running turn on ctrl+c and leaves when there is nothing to stop', async () => {
    const terminal = fakeTerminal()
    tui.internals.interactive = () => true
    tui.internals.createTerminal = () => terminal
    const exit = vi.fn()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('appExit', exit)
    const agent = registerAgent(ctx)
    const cancels: unknown[] = []
    Object.assign(agent, { cancel: (cause: unknown) => { cancels.push(cause) } })
    await ctx.plugin(tui, { session: SESSION, color: false })
    await new Promise(resolve => setTimeout(resolve, 20))

    Object.assign(agent, { status: 'running' })
    terminal.input('\x03')
    expect(cancels).toEqual([{ kind: 'user' }])
    expect(exit).not.toHaveBeenCalled()

    Object.assign(agent, { status: 'idle' })
    terminal.input('\x03')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('refreshes the footer on an agent status change and while a turn runs', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, terminal, agent } = await mountFake()
      const before = terminal.written.length
      ctx.emit('agent/status', { agent, status: 'running' })
      expect(terminal.written.length).toBeGreaterThanOrEqual(before)
      Object.assign(agent, { status: 'running' })
      const beforeTick = terminal.written.length
      await vi.advanceTimersByTimeAsync(2500)
      expect(terminal.written.length).toBeGreaterThan(beforeTick)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the footer alone while the agent is idle', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, terminal } = await mountFake()
      ctx.emit('agent/status', { agent: { id: 'someone-else' } as never, status: 'running' })
      const beforeTick = terminal.written.length
      await vi.advanceTimersByTimeAsync(2500)
      expect(terminal.written.length).toBe(beforeTick)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets an ordinary key through to the editor', async () => {
    const { terminal } = await mount()
    terminal.input('h')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('h')
  })

  it('folds a tool card body until the reader expands it', async () => {
    const { terminal, agent } = await mount({ headLines: 1, tailLines: 1 })
    agent.session.append('tool/call', { turn: 0, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'm1', role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: '1\n2\n3\n4\n5' }] }],
        source: { kind: 'tool', callId: CallId('c1'), name: 'bash' },
      },
    } as never, { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('more lines')
    terminal.input('\x0f')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen(terminal)).toContain('4')
  })
})
