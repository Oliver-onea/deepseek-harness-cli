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
function fakeTui(rows = 24): ViewportTUI & {
  renders: number
  layoutRoot: Component | undefined
  focused: Component | null
  overlays: Component[]
} {
  const hidden: Component[] = []
  const tui = {
    renders: 0,
    layoutRoot: undefined as Component | undefined,
    focused: null as Component | null,
    overlays: [] as Component[],
    hidden,
    terminal: { columns: 80, rows } as unknown as Terminal,
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

interface StateReaders {
  goal?: () => { objective: string; phase: string } | undefined
  planMode?: () => { active: boolean; pending?: boolean }
  permissionPreset?: () => string | undefined
}

/** The editor the shell focused, with the autocomplete surface tests drive. */
type FocusedEditor = {
  handleInput(data: string): void
  render(width: number): string[]
  getText(): string
  isShowingAutocomplete(): boolean
}

/** Let one query settle: suggestion requests run through microtasks. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Resolve once the condition holds, polling past the @ trigger's debounce.
 * @param ready - the condition to poll.
 * @param timeoutMs - how long to wait before failing.
 */
async function when(ready: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!ready()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition did not hold in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A shell whose editor carries the input-trigger menus over a mutable roster. */
function shellWithMenus(over: { rows?: number; children?: { name: string }[] } = {}): {
  shell: TerminalShell
  tui: ReturnType<typeof fakeTui>
  agent: AgentStub
  roster: { name: string; description: string }[]
  children: { name: string }[]
  editor: () => FocusedEditor
} {
  const roster = [
    { name: 'compact', description: 'Summarize the conversation' },
    { name: 'exit', description: 'Leave the terminal session' },
  ]
  const children = over.children ?? []
  const tui = fakeTui(over.rows)
  const agent = fakeAgent()
  const shell = new TerminalShell({
    tui,
    agent,
    palette: createPalette(false),
    presenter,
    commands: undefined,
    tokenMeter: undefined,
    headLines: 4,
    tailLines: 2,
    showReasoning: false,
    defaultRoute: undefined,
    autocomplete: {
      commands: () => roster,
      subagents: async () => children,
      maxVisible: 8,
    },
  })
  shell.start()
  return {
    shell, tui, agent, roster, children,
    editor: () => tui.focused as unknown as FocusedEditor,
  }
}

function shellFor(over: { agent?: AgentStub; commands?: CommandRuntime; state?: StateReaders } = {}): {
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
    goal: over.state?.goal,
    planMode: over.state?.planMode,
    permissionPreset: over.state?.permissionPreset,
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

  it('notes a route chosen ahead of its request and drops the old context capacity', () => {
    const { shell, tui, agent } = shellFor()
    shell.start()
    shell.observe(agent.session.append('request/context', { provider: 'q', model: 'n', contextWindow: 1000 }))
    const withCapacity = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(withCapacity).toContain('q/n')
    expect(withCapacity).toContain('(0%)')

    shell.noteRoute('r', 'o')
    const noted = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(noted).toContain('r/o')
    expect(noted).toContain('0 tokens')
    expect(noted).not.toContain('(0%)')

    // The request that consumes the new route restates the capacity it runs on.
    shell.observe(agent.session.append('request/context', { provider: 'r', model: 'o', contextWindow: 2000 }))
    const served = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(served).toContain('r/o')
    expect(served).toContain('(0%)')
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
    // A handler may reject with any value; the terminal still has to name it.
    const thrown: unknown = 'plain string failure'
    const commands = {
      find: (_agent: Agent, name: string) => (name === 'boom' ? { name } : undefined),
      execute: () => { throw thrown },
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

  it('shows session-state indicators in the footer when readers supply them', () => {
    const { shell, tui } = shellFor({
      state: {
        goal: () => ({ objective: 'ship it', phase: 'active' }),
        planMode: () => ({ active: true }),
        permissionPreset: () => 'workspace-write',
      },
    })
    shell.start()
    const drawn = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(drawn).toContain('goal: ship it')
    expect(drawn).toContain('plan')
    expect(drawn).toContain('workspace-write')
  })

  it('hides session-state indicators when readers are absent', () => {
    const { shell, tui } = shellFor()
    shell.start()
    const drawn = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(drawn).not.toContain('goal:')
    expect(drawn).not.toContain('plan')
    expect(drawn).not.toContain('workspace-write')
  })

  it('reflects changing goal state without a new session event', () => {
    let goal: { objective: string; phase: string } | undefined = { objective: 'first', phase: 'active' }
    const { shell, tui } = shellFor({ state: { goal: () => goal } })
    shell.start()
    const before = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(before).toContain('goal: first')
    goal = undefined
    shell.refreshStatus()
    const after = (tui.layoutRoot as { render(width: number): string[] }).render(80).join('\n')
    expect(after).not.toContain('goal:')
  })
})

describe('TerminalShell input-trigger menus', () => {
  it('offers the live roster under a slash prefix, with descriptions', async () => {
    const { editor } = shellWithMenus()
    editor().handleInput('/')
    await settle()
    expect(editor().isShowingAutocomplete()).toBe(true)
    const drawn = editor().render(80).join('\n')
    expect(drawn).toContain('compact')
    expect(drawn).toContain('Summarize the conversation')
    expect(drawn).toContain('exit')
  })

  it('shows a command registered after the menus were wired, without a restart', async () => {
    const { editor, roster } = shellWithMenus()
    editor().handleInput('/')
    await settle()
    editor().handleInput('\x1b')
    expect(editor().isShowingAutocomplete()).toBe(false)
    roster.push({ name: 'goal', description: 'set or view the goal' })
    editor().handleInput('g')
    await settle()
    expect(editor().render(80).join('\n')).toContain('set or view the goal')
  })

  it('narrows to the typed prefix', async () => {
    const { editor } = shellWithMenus()
    editor().handleInput('/')
    await settle()
    editor().handleInput('e')
    await settle()
    const drawn = editor().render(80).join('\n')
    expect(drawn).toContain('exit')
    expect(drawn).not.toContain('compact')
  })

  it('dismisses on escape and stays dismissed', async () => {
    const { editor } = shellWithMenus()
    editor().handleInput('/')
    await settle()
    expect(editor().isShowingAutocomplete()).toBe(true)
    editor().handleInput('\x1b')
    expect(editor().isShowingAutocomplete()).toBe(false)
    expect(editor().render(80).join('\n')).not.toContain('compact')
  })

  it('moves the selection with the keyboard and completes it on tab', async () => {
    const { editor } = shellWithMenus()
    editor().handleInput('/')
    await settle()
    editor().handleInput('\x1b[B')
    editor().handleInput('\t')
    expect(editor().getText()).toBe('/exit ')
    expect(editor().isShowingAutocomplete()).toBe(false)
  })

  it('completes an @ pick as the verbatim reference with a trailing space', async () => {
    const { editor } = shellWithMenus({ children: [{ name: 'scan-runner' }] })
    editor().handleInput('@')
    await when(() => editor().isShowingAutocomplete())
    editor().handleInput('\t')
    expect(editor().getText()).toBe('@scan-runner ')
    expect(editor().isShowingAutocomplete()).toBe(false)
  })

  it('submits a completed slash pick as a command, not as a model turn', async () => {
    const execute = vi.fn(() => Promise.resolve(undefined))
    const roster = [
      { name: 'compact', description: 'Summarize the conversation' },
      { name: 'exit', description: 'Leave the terminal session' },
    ]
    const tui = fakeTui()
    const agent = fakeAgent()
    const shell = new TerminalShell({
      tui,
      agent,
      palette: createPalette(false),
      presenter,
      commands: {
        find: (_agent: Agent, name: string) => (name === 'compact' ? { name } : undefined),
        execute,
      } as unknown as CommandRuntime,
      tokenMeter: undefined,
      headLines: 4,
      tailLines: 2,
      showReasoning: false,
      defaultRoute: undefined,
      autocomplete: {
        commands: () => roster,
        maxVisible: 8,
      },
    })
    shell.start()
    const editor = tui.focused as unknown as FocusedEditor
    editor.handleInput('/')
    await settle()
    editor.handleInput('\r')
    await settle()
    expect(execute).toHaveBeenCalledOnce()
    expect(agent.followups).toHaveLength(0)
  })

  it('esc with a menu open dismisses the menu only, keeping the turn and queued work', async () => {
    const { shell, agent, editor } = shellWithMenus()
    Object.assign(agent, { status: 'running' as const })
    agent.followups.push({} as UserMessage)
    editor().handleInput('/')
    await settle()
    expect(editor().isShowingAutocomplete()).toBe(true)

    expect(shell.handleKey(ESCAPE)).toBe(true)
    expect(editor().isShowingAutocomplete()).toBe(false)
    expect(agent.cancels).toEqual([])
    // With the menu closed, the same key resumes its interrupt meaning.
    expect(shell.handleKey(ESCAPE)).toBe(true)
    expect(agent.cancels).toEqual([{ kind: 'user' }])
    // The queued follow-up was never cleared: no cancel reached the agent
    // while the menu was open.
    expect(agent.followups).toHaveLength(1)
  })

  it('offers no menu on a terminal too small for one candidate row', async () => {
    const { editor } = shellWithMenus({ rows: 5 })
    editor().handleInput('/')
    await settle()
    expect(editor().isShowingAutocomplete()).toBe(false)
    expect(editor().render(20).join('\n')).not.toContain('compact')
  })

  it('leaves the row gate inert: keys reach the editor and enter submits the literal text', async () => {
    const execute = vi.fn(() => Promise.resolve(undefined))
    const roster = [{ name: 'exit', description: 'Leave the terminal session' }]
    const tui = fakeTui(5)
    const agent = fakeAgent()
    const shell = new TerminalShell({
      tui,
      agent,
      palette: createPalette(false),
      presenter,
      commands: {
        find: (_agent: Agent, name: string) => (name === 'exit' ? { name } : undefined),
        execute,
      } as unknown as CommandRuntime,
      tokenMeter: undefined,
      headLines: 4,
      tailLines: 2,
      showReasoning: false,
      defaultRoute: undefined,
      autocomplete: {
        commands: () => roster,
        maxVisible: 8,
      },
    })
    shell.start()
    const editor = tui.focused as unknown as FocusedEditor
    // The trigger key and the selection keys all pass through to the editor;
    // no invisible list captures them, so nothing is applied.
    editor.handleInput('/')
    await settle()
    editor.handleInput('\x1b[B')
    editor.handleInput('\x1b[B')
    editor.handleInput('\t')
    await settle()
    expect(editor.isShowingAutocomplete()).toBe(false)
    expect(editor.getText()).toBe('/')
    editor.handleInput('e')
    editor.handleInput('x')
    editor.handleInput('i')
    editor.handleInput('t')
    expect(editor.getText()).toBe('/exit')
    editor.handleInput('\r')
    await settle()
    // Enter submitted exactly what was typed — the literal command line.
    expect(execute).toHaveBeenCalledOnce()
    expect(agent.followups).toHaveLength(0)
  })

  it('bounds the menu rows to what a small terminal can show', async () => {
    const { editor } = shellWithMenus({ rows: 8 })
    editor().handleInput('/')
    await settle()
    const rows = editor().render(20)
    const menuRows = rows.filter(line => line.includes('compact') || line.includes('exit')).length
    expect(menuRows).toBe(2)
  })

  it('draws the same menu layout with and without color', async () => {
    const draw = async (color: boolean): Promise<string> => {
      const tui = fakeTui()
      const roster = [
        { name: 'compact', description: 'Summarize the conversation' },
        { name: 'exit', description: 'Leave the terminal session' },
      ]
      const shell = new TerminalShell({
        tui,
        agent: fakeAgent(),
        palette: createPalette(color),
        presenter,
        commands: undefined,
        tokenMeter: undefined,
        headLines: 4,
        tailLines: 2,
        showReasoning: false,
        defaultRoute: undefined,
        autocomplete: {
          commands: () => roster,
          maxVisible: 8,
        },
      })
      shell.start()
      const editor = tui.focused as unknown as FocusedEditor
      editor.handleInput('/')
      await settle()
      return editor.render(80).join('\n')
        .replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/gu, '')
    }
    expect(await draw(false)).toBe(await draw(true))
  })
})
