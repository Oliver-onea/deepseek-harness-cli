import { describe, expect, it, vi } from 'vitest'
import type { Component, OverlayHandle, Terminal, ViewportTUI } from '@earendil-works/pi-tui'
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent'
import { CommandId, type CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TerminalShell, classifySubmission, commandNameOf, paneTitle } from '../src/shell.ts'
import { createPalette } from '../src/theme.ts'
import type { ToolPresenter } from '../src/view.ts'

const ESCAPE = '\x1b'

/** A renderer stand-in: the shell owns layout and focus, the drawing is pi-tui's. */
function fakeTui(): ViewportTUI & { renders: number; layoutRoot: Component | undefined; focused: Component | null; overlays: Component[] } {
  const hidden: Component[] = []
  const tui = {
    renders: 0,
    layoutRoot: undefined as Component | undefined,
    focused: null as Component | null,
    overlays: [] as Component[],
    hidden,
    terminal: { columns: 80, rows: 24 } as unknown as Terminal,
    setLayoutRoot(component: Component | undefined): void { tui.layoutRoot = component },
    setFocus(component: Component | null): void { tui.focused = component },
    requestRender(): void { tui.renders += 1 },
    showOverlay(component: Component): OverlayHandle {
      tui.overlays.push(component)
      return {
        hide(): void { hidden.push(component) },
        setHidden(): void {}, isHidden: () => false,
        focus(): void {}, unfocus(): void {}, isFocused: () => true,
      }
    },
  }
  return tui as unknown as ViewportTUI & typeof tui
}

interface AgentStub extends Agent {
  cancels: AgentCancelCause[]
  followups: UserMessage[]
  steers: UserMessage[]
}

/** An agent stand-in over a REAL session, so the fold sees genuine logged events. */
function fakeAgent(status: 'idle' | 'running' = 'idle'): AgentStub {
  const session = Session.create(SessionId('session-shell'))
  const stub = {
    id: session.id,
    session,
    status,
    options: { provider: 'p', model: 'm' },
    inbox: { nextTurn: [], nextStep: [] },
    cancels: [] as AgentCancelCause[],
    followups: [] as UserMessage[],
    steers: [] as UserMessage[],
    cancel(cause: AgentCancelCause): void { stub.cancels.push(cause) },
    followup(message: UserMessage): void { stub.followups.push(message) },
    steer(message: UserMessage): void { stub.steers.push(message) },
  }
  return stub as unknown as AgentStub
}

const presenter: ToolPresenter = { presentCall: () => undefined, presentResult: () => undefined }

function shellFor(over: { agent?: AgentStub; commands?: CommandRuntime } = {}): {
  shell: TerminalShell
  tui: ReturnType<typeof fakeTui>
  agent: AgentStub
} {
  const tui = fakeTui()
  const agent = over.agent ?? fakeAgent()
  const shell = new TerminalShell({
    tui,
    agent,
    palette: createPalette(false),
    presenter,
    commands: over.commands,
    tokenMeter: undefined,
    headLines: 4,
    tailLines: 2,
    showReasoning: false,
    defaultRoute: undefined,
  })
  return { shell, tui, agent }
}

/** Type one line into the focused editor and submit it, the way a reader does. */
async function submit(tui: ReturnType<typeof fakeTui>, line: string): Promise<void> {
  const editor = tui.focused as { handleInput(data: string): void }
  for (const character of line) editor.handleInput(character)
  editor.handleInput('\r')
  await Promise.resolve()
  await Promise.resolve()
}

describe('commandNameOf', () => {
  it.each([
    ['/compact', 'compact'],
    ['/model gpt', 'model'],
    ['not a command', undefined],
    ['/Bad', undefined],
    ['/compacted-name', 'compacted-name'],
  ])('reads %s as %s', (line, expected) => {
    expect(commandNameOf(line)).toBe(expected)
  })
})

describe('classifySubmission', () => {
  it('routes a resolved command as a command and everything else as a prompt', () => {
    expect(classifySubmission('/compact', true)).toEqual({ kind: 'command', line: '/compact' })
    expect(classifySubmission('/compact', false)).toEqual({ kind: 'prompt', text: '/compact' })
  })
})

describe('paneTitle', () => {
  it('names the pane after the model, with controls escaped', () => {
    expect(paneTitle('deepseek-v4')).toBe('dsh — deepseek-v4')
    expect(paneTitle('a\x1b]0;b\x07')).toBe('dsh — a\\x1b]0;b\\x07')
  })
})

describe('TerminalShell', () => {
  it('composes the layout and gives the editor the keyboard', () => {
    const { shell, tui } = shellFor()
    shell.start()
    expect(tui.layoutRoot).toBeDefined()
    expect(tui.focused).not.toBeNull()
  })

  it('reports the configured route until a request logs the one actually used', () => {
    const { shell, agent } = shellFor()
    expect(shell.model).toBe('m')
    shell.observe(agent.session.append('request/context', { provider: 'q', model: 'n', contextWindow: 1000 }))
    expect(shell.model).toBe('n')
  })

  it('falls back to the deployment default route, then to a placeholder', () => {
    const tui = fakeTui()
    const bare = { ...fakeAgent(), options: {} } as unknown as Agent
    const withDefault = new TerminalShell({
      tui, agent: bare, palette: createPalette(false), presenter,
      commands: undefined, tokenMeter: undefined, headLines: 4, tailLines: 2,
      showReasoning: false, defaultRoute: { provider: 'd', model: 'dm' },
    })
    expect(withDefault.model).toBe('dm')
    const withNothing = new TerminalShell({
      tui, agent: bare, palette: createPalette(false), presenter,
      commands: undefined, tokenMeter: undefined, headLines: 4, tailLines: 2,
      showReasoning: false, defaultRoute: undefined,
    })
    expect(withNothing.model).toBe('default')
  })

  it('redraws when an observed event changes the conversation', () => {
    const { shell, tui, agent } = shellFor()
    shell.start()
    const before = tui.renders
    shell.observe(agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
    expect(tui.renders).toBeGreaterThan(before)
  })

  it('times a running turn from its own start event', () => {
    const { shell, agent } = shellFor()
    shell.observe(agent.session.append('turn/start', { turn: 0 }))
    shell.observe(agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } }))
    expect(shell.model).toBe('m')
  })

  it('sends an idle agent a follow-up turn and a running agent steering', () => {
    const { shell, agent } = shellFor()
    shell.prompt('do the thing')
    expect(agent.followups).toHaveLength(1)
    expect(agent.steers).toHaveLength(0)
    const running = fakeAgent('running')
    shellFor({ agent: running }).shell.prompt('and this too')
    expect(running.steers).toHaveLength(1)
    expect(running.followups).toHaveLength(0)
  })

  it('interrupts the turn on escape', () => {
    const { shell, agent } = shellFor()
    expect(shell.handleKey(ESCAPE)).toBe(true)
    expect(agent.cancels).toEqual([{ kind: 'user' }])
  })

  it('toggles reasoning and card expansion from the keyboard', () => {
    const { shell, tui } = shellFor()
    const before = tui.renders
    expect(shell.handleKey('\x12')).toBe(true)
    expect(shell.handleKey('\x0f')).toBe(true)
    expect(tui.renders).toBe(before + 2)
  })

  it('leaves other keys to the editor', () => {
    const { shell } = shellFor()
    expect(shell.handleKey('a')).toBe(false)
  })

  it('gives a live panel the keyboard and takes it back when the panel closes', () => {
    const { shell, tui } = shellFor()
    shell.start()
    const panel = { render: () => [], invalidate: () => {} }
    const close = shell.present(panel)
    expect(tui.overlays).toEqual([panel])
    expect(shell.handleKey(ESCAPE)).toBe(false)
    close()
    expect(shell.handleKey(ESCAPE)).toBe(true)
  })

  it('asks for a redraw on request', () => {
    const { shell, tui } = shellFor()
    const before = tui.renders
    shell.requestRender()
    expect(tui.renders).toBe(before + 1)
  })

  it('dispatches a resolved slash command instead of prompting the model', async () => {
    const execute = vi.fn(() => Promise.resolve(undefined))
    const commands = {
      find: (_agent: Agent, name: string) => (name === 'compact' ? { name } : undefined),
      execute,
    } as unknown as CommandRuntime
    const { shell, tui, agent } = shellFor({ commands })
    shell.start()
    await submit(tui, '/compact')
    expect(execute).toHaveBeenCalledOnce()
    expect(agent.followups).toHaveLength(0)
  })

  it('keeps a throwing command from ending the session, and shows what the log did not record', async () => {
    const commands = {
      find: (_agent: Agent, name: string) => (name === 'boom' ? { name } : undefined),
      execute: () => Promise.reject(new Error('handler exploded')),
    } as unknown as CommandRuntime
    const { shell, tui } = shellFor({ commands })
    shell.start()
    await submit(tui, '/boom')
    const drawn = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(drawn).toContain('handler exploded')
  })

  it('reports a thrown non-Error command failure without losing its text', async () => {
    const commands = {
      find: (_agent: Agent, name: string) => (name === 'boom' ? { name } : undefined),
      // eslint-disable-next-line prefer-promise-reject-errors -- a handler may throw any value.
      execute: () => Promise.reject('plain string failure'),
    } as unknown as CommandRuntime
    const { shell, tui } = shellFor({ commands })
    shell.start()
    await submit(tui, '/boom')
    const drawn = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(drawn).toContain('plain string failure')
  })

  it('leaves a failure the command log already recorded to the transcript', async () => {
    const agent = fakeAgent()
    const commands = {
      find: (_agent: Agent, name: string) => (name === 'boom' ? { name } : undefined),
      execute: () => {
        agent.session.append('command/done', { commandId: CommandId('cmd-1'), kind: 'error', text: 'recorded reason' })
        return Promise.reject(new Error('handler exploded'))
      },
    } as unknown as CommandRuntime
    const { shell, tui } = shellFor({ agent, commands })
    shell.start()
    await submit(tui, '/boom')
    const drawn = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(drawn).not.toContain('handler exploded')
  })

  it('prompts the model with a slash line the registry does not resolve', async () => {
    const commands = { find: () => undefined, execute: vi.fn() } as unknown as CommandRuntime
    const { shell, tui, agent } = shellFor({ commands })
    shell.start()
    await submit(tui, '/nope')
    expect(agent.followups).toHaveLength(1)
  })

  it('prompts the model when the composition mounts no command registry', async () => {
    const { shell, tui, agent } = shellFor()
    shell.start()
    await submit(tui, '/compact')
    expect(agent.followups).toHaveLength(1)
  })

  it('prompts the model with ordinary text while a registry is composed', async () => {
    const commands = { find: () => undefined, execute: vi.fn() } as unknown as CommandRuntime
    const { shell, tui, agent } = shellFor({ commands })
    shell.start()
    await submit(tui, 'hello there')
    expect(agent.followups).toHaveLength(1)
  })

  it('sends nothing for a blank submission', async () => {
    const { shell, tui, agent } = shellFor()
    shell.start()
    await submit(tui, '   ')
    expect(agent.followups).toHaveLength(0)
  })

  it('measures context pressure when the composition mounts a meter', () => {
    const measure = vi.fn(() => ({ totalTokens: 1234 }))
    const tui = fakeTui()
    const shell = new TerminalShell({
      tui,
      agent: fakeAgent(),
      palette: createPalette(false),
      presenter,
      commands: undefined,
      tokenMeter: { measure } as never,
      headLines: 4,
      tailLines: 2,
      showReasoning: false,
      defaultRoute: undefined,
    })
    shell.refreshStatus()
    expect(measure).toHaveBeenCalled()
  })
})
