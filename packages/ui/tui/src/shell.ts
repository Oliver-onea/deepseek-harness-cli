/**
 * The terminal shell: the layout, key routing, and input plumbing that turn one
 * live agent into a full-screen conversation. It owns presentation only —
 * turns, persistence, tools, and commands stay with their own services.
 * @module @deepseek-ai/dsh-tui/shell
 */

import {
  Editor,
  Loader,
  ScrollView,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type LoaderIndicatorOptions,
  type ViewportTUI,
} from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { TerminalAutocomplete } from './autocomplete.ts'
import type { AutocompleteOptions } from './autocomplete.ts'
import { displayLine } from './display-text.ts'
import { composeColdOpen } from './header.ts'
import type { PanelHost } from './questions.ts'
import { renderStatus } from './status.ts'
import type { StatusGoal, StatusPlanMode } from './status.ts'
import type { ColorDepth, Palette } from './theme.ts'
import { Transcript } from './transcript.ts'
import { TranscriptView, type AttachmentImageReader, type ToolPresenter } from './view.ts'

/** Everything the shell needs from the composition around it. */
export interface ShellOptions {
  /** The renderer this shell draws through. */
  tui: ViewportTUI
  /** The single agent this terminal drives. */
  agent: Agent
  /** The styles to draw with. */
  palette: Palette
  /** The color depth the palette draws at, if any. */
  colorDepth?: ColorDepth | undefined
  /** The tool-view lookups the transcript uses. */
  presenter: ToolPresenter
  /** The slash-command registry, when the composition mounts one. */
  commands: CommandRuntime | undefined
  /** The token meter behind the context field, when the composition mounts one. */
  tokenMeter: TokenMeter | undefined
  /** Read the current goal, when the composition mounts a goal service. */
  goal?: (() => StatusGoal | undefined) | undefined
  /** Read plan-mode state, when the composition mounts plan mode. */
  planMode?: (() => StatusPlanMode) | undefined
  /** Read the effective permission preset, when the composition mounts permission presets. */
  permissionPreset?: (() => string | undefined) | undefined
  /** Lines kept at the head of a folded tool-card body. */
  headLines: number
  /** Lines kept at the tail of a folded tool-card body. */
  tailLines: number
  /** Whether reasoning starts visible. */
  showReasoning: boolean
  /** Reads image bytes for inline rendering; absent renders every image's text fallback. */
  imageReader: AttachmentImageReader | undefined
  /** Maximum inline image width in terminal cells. */
  imageMaxWidthCells: number
  /** Maximum inline image height in terminal cells; unset keeps the image's own aspect ratio. */
  imageMaxHeightCells: number | undefined
  /**
   * The deployment's default route, shown until the session's first request
   * logs the one it actually used. Absent when the composition mounts no
   * default-model service.
   */
  defaultRoute: { provider: string; model: string } | undefined
  /**
   * The input-trigger menus, when the composition wires them: `/` offers the
   * commands the live registry resolves, `@` offers running subagent
   * children.
   */
  autocomplete?: AutocompleteOptions | undefined
}

/** The editor's placeholder-free border styling. */
const EDITOR_PADDING_X = 1

/** The footer's spinner frames while a turn runs. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The footer's spinner cadence in milliseconds. */
const SPINNER_INTERVAL_MS = 80

/** The editor's placeholder, shown dim while the input is empty. */
const EDITOR_PLACEHOLDER = '/ for commands'

/** The prompt marker that prefixes the editor's input row. */
const PROMPT_MARKER = '›'

/** Editor columns kept usable before the prompt gutter may take any width. */
const MIN_EDITOR_COLUMNS = 8

/** A style that adds nothing, for footer fields the palette already styled. */
const IDENTITY_STYLE = (text: string): string => text

/**
 * Route one submitted line: a slash command the registry knows runs as a
 * command, a line shaped like a slash command it does not know is refused
 * locally, and everything else is conversation.
 */
type Submission =
  | { kind: 'command'; line: string }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'prompt'; text: string }

/**
 * Classify a submitted line without dispatching it.
 *
 * A line that parses as a command name the registry cannot resolve never
 * becomes conversation. Forwarding it would send its arguments to the model,
 * and a mistyped `/credential` carries a secret in those arguments.
 * {@link commandNameOf} only matches a slash followed by an identifier and a
 * word break, so ordinary prose beginning with a path stays a prompt.
 * A composition that mounts no registry has no commands to be unknown against,
 * so every line there is conversation.
 * @param line - the exact text the reader submitted.
 * @param known - whether the registry resolves this line to a command.
 * @param registryMounted - whether the composition serves a command registry at all.
 * @returns how the line should be handled.
 */
export function classifySubmission(line: string, known: boolean, registryMounted: boolean): Submission {
  if (known) return { kind: 'command', line }
  const name = commandNameOf(line)
  if (name === undefined || !registryMounted) return { kind: 'prompt', text: line }
  return { kind: 'unknown-command', name }
}

/** The live terminal conversation. */
export class TerminalShell implements PanelHost {
  private readonly transcript = new Transcript()
  private readonly view: TranscriptView
  private readonly editor: Editor
  private readonly inputRow: Component
  private readonly status: Loader
  private readonly runningIndicator: LoaderIndicatorOptions
  private readonly idleIndicator: LoaderIndicatorOptions
  private statusRunning: boolean | undefined
  private readonly panels = new Set<Component>()
  private turnStartedAt: number | undefined
  private contextWindow: number | undefined
  private route: { provider: string; model: string }

  /**
   * @param options - the services, styles, and callbacks this shell runs on.
   */
  constructor(private readonly options: ShellOptions) {
    const agentOptions = options.agent.options
    this.route = {
      provider: agentOptions.provider ?? options.defaultRoute?.provider ?? 'default',
      model: agentOptions.model ?? options.defaultRoute?.model ?? 'default',
    }
    this.view = new TranscriptView(this.transcript, {
      palette: options.palette,
      presenter: options.presenter,
      images: {
        reader: options.imageReader,
        maxWidthCells: options.imageMaxWidthCells,
        maxHeightCells: options.imageMaxHeightCells,
        requestRender: () => { this.options.tui.requestRender() },
      },
    })
    this.view.reasoning = options.showReasoning
    this.view.layout = { headLines: options.headLines, tailLines: options.tailLines, expanded: false }
    // The run state rides the indicator — a spinner while a turn runs, a
    // green dot while idle — so the footer reads the state before the words.
    this.runningIndicator = {
      frames: SPINNER_FRAMES.map(frame => options.palette.warn(frame)),
      intervalMs: SPINNER_INTERVAL_MS,
    }
    this.idleIndicator = { frames: [options.palette.success('●')] }
    this.status = new Loader(options.tui, options.palette.warn, IDENTITY_STYLE, '', this.idleIndicator)
    this.editor = new Editor(options.tui, {
      borderColor: options.palette.dim,
      selectList: {
        selectedPrefix: options.palette.tool,
        selectedText: options.palette.selected,
        description: options.palette.dim,
        scrollInfo: options.palette.dim,
        noMatch: options.palette.dim,
      },
    }, { paddingX: EDITOR_PADDING_X })
    this.editor.onSubmit = (text: string) => { void this.submit(text) }
    // The prompt marker sits in a gutter beside the editor's input row; while
    // the input is empty it reads as a dim placeholder naming what the reader
    // can do. The gutter is sized from the terminal width so a narrow terminal
    // keeps a usable editor, and drops the gutter entirely below the floor.
    this.inputRow = {
      render: (width: number) => this.renderInputRow(width),
      invalidate: () => { this.editor.invalidate() },
    }
    this.editor.onChange = () => { this.options.tui.requestRender() }
    const autocomplete = options.autocomplete
    if (autocomplete !== undefined) {
      this.editor.setAutocompleteProvider(new TerminalAutocomplete({
        ...autocomplete,
        rows: () => options.tui.terminal.rows,
        syncMaxVisible: (visible) => { this.editor.setAutocompleteMaxVisible(visible) },
      }))
    }
  }

  /** Compose the layout and take the keyboard. */
  start(): void {
    const tui = this.options.tui
    tui.setLayoutRoot(new VStack([
      {
        component: new ScrollView(this.view, { follow: 'end', primary: true, overscroll: 'chain' }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      {
        component: new VStack([this.inputRow, this.status]),
        basis: 'auto',
        shrink: 1,
        minSize: 1,
      },
    ]))
    tui.setFocus(this.editor)
    this.refreshStatus()
  }

  /**
   * Seed the cold-open header over an empty transcript; a resumed one keeps
   * its own first entry.
   */
  seedColdOpen(): void {
    this.transcript.seedHeader(composeColdOpen({
      provider: this.route.provider,
      model: this.route.model,
      permissionPreset: this.options.permissionPreset?.(),
      cwd: this.options.agent.session.header.cwd ?? process.cwd(),
      depth: this.options.colorDepth,
      columns: this.options.tui.terminal.columns,
      rows: this.options.tui.terminal.rows,
    }, this.options.palette))
  }

  /**
   * Fold one durable event and redraw when it changed the conversation.
   * @param event - the appended session event.
   */
  observe(event: SessionEvent): void {
    if (event.type === 'turn/start') this.turnStartedAt = Date.now()
    if (event.type === 'turn/end') this.turnStartedAt = undefined
    // Route metadata is logged only when it changes, so the latest one seen is
    // what the next request will use — more authoritative than the creation
    // options, which say nothing about an adapter-resolved or reselected route.
    if (event.type === 'request/context') {
      this.route = { provider: event.data.provider, model: event.data.model }
      this.contextWindow = event.data.contextWindow
    }
    if (this.transcript.append(event)) this.options.tui.requestRender()
    this.refreshStatus()
  }

  /** Recompose the footer from current session state. */
  refreshStatus(): void {
    const agent = this.options.agent
    const measurement = this.options.tokenMeter?.measure(agent.session)
    const running = agent.status === 'running'
    if (this.statusRunning !== running) {
      this.statusRunning = running
      this.status.setIndicator(running ? this.runningIndicator : this.idleIndicator)
    }
    this.status.setMessage(renderStatus({
      running,
      provider: this.route.provider,
      model: this.route.model,
      elapsedMs: this.turnStartedAt === undefined ? 0 : Date.now() - this.turnStartedAt,
      tokens: measurement?.totalTokens ?? 0,
      contextWindow: this.contextWindow,
      queued: agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
      todos: this.transcript.todos,
      goal: this.options.goal?.(),
      planMode: this.options.planMode?.(),
      permissionPreset: this.options.permissionPreset?.(),
    }, this.options.palette))
    this.options.tui.requestRender()
  }

  /** Stop the footer's animation; the screen effect calls this on teardown. */
  stopStatus(): void {
    this.status.stop()
  }

  /**
   * Compose the editor's input row with a prompt gutter beside it. The gutter
   * carries the `›` marker, and while the input is empty and no menu is open
   * it widens into a dim placeholder naming what the reader can do; once the
   * reader types or opens a menu it narrows to the marker so the editor and
   * its inline menu keep their width. The gutter drops out entirely on a
   * terminal too narrow to keep the editor usable beside it.
   * @param width - the row's available width in columns.
   * @returns the composed lines.
   */
  private renderInputRow(width: number): string[] {
    const palette = this.options.palette
    const marker = palette.user(PROMPT_MARKER)
    const markerGutter = visibleWidth(`${PROMPT_MARKER} `)
    let gutter = 0
    let content = ''
    if (this.editor.getText() === '' && !this.editor.isShowingAutocomplete()) {
      const full = visibleWidth(`${PROMPT_MARKER} ${EDITOR_PLACEHOLDER}`)
      const available = Math.min(full, width - MIN_EDITOR_COLUMNS)
      if (available >= markerGutter) {
        gutter = available
        content = truncateToWidth(`${marker} ${palette.dim(EDITOR_PLACEHOLDER)}`, gutter)
      }
    }
    if (gutter === 0 && width - MIN_EDITOR_COLUMNS >= markerGutter) {
      gutter = markerGutter
      content = marker
    }
    if (gutter === 0) return this.editor.render(width)
    content += ' '.repeat(Math.max(0, gutter - visibleWidth(content)))
    const editorLines = this.editor.render(Math.max(1, width - gutter))
    const blank = ' '.repeat(gutter)
    /* v8 ignore next -- the editor borders make a real render at least two lines, so the marker row is always 1 */
    const markerRow = editorLines.length >= 2 ? 1 : 0
    return editorLines.map((line, index) => (index === markerRow ? content : blank) + line)
  }

  /**
   * Show one panel over the conversation and give it the keyboard.
   * @param panel - the component to display.
   * @returns a disposer that removes the panel and restores editor focus.
   */
  present(panel: Component): () => void {
    const tui = this.options.tui
    this.panels.add(panel)
    const handle = tui.showOverlay(panel, { anchor: 'bottom-left', width: '80%', margin: 1 })
    tui.requestRender()
    return () => {
      this.panels.delete(panel)
      handle.hide()
      tui.setFocus(this.editor)
      tui.requestRender()
    }
  }

  /** The model id requests currently use. */
  get model(): string {
    return this.route.model
  }

  /**
   * Record a route chosen ahead of the request that will log it: the footer
   * names the new route immediately, and the old route's advertised context
   * capacity stops applying until the next request states the new one.
   * @param provider - the provider route subsequent requests carry.
   * @param model - the model id subsequent requests carry.
   */
  noteRoute(provider: string, model: string): void {
    this.route = { provider, model }
    this.contextWindow = undefined
    this.refreshStatus()
  }

  /** Ask the renderer to draw again. */
  requestRender(): void {
    this.options.tui.requestRender()
  }

  /** Cancel every in-flight image read; called when the plugin tears down. */
  dispose(): void {
    this.view.dispose()
  }

  /**
   * Handle the terminal-only controls. Keys that belong to a live panel, to
   * the open suggestion menu, or to the editor are not claimed here.
   * @param data - the raw input sequence.
   * @returns whether this shell consumed the key.
   */
  handleKey(data: string): boolean {
    if (this.panels.size > 0) return false
    if (this.editor.isShowingAutocomplete() && matchesKey(data, 'escape')) {
      // Esc with a menu open dismisses the menu only: the running turn keeps
      // running and queued work survives, because cancel would clear it.
      // The editor's own dismiss path repaints nothing, so request the draw.
      this.editor.handleInput(data)
      this.options.tui.requestRender()
      return true
    }
    if (matchesKey(data, 'escape')) {
      this.options.agent.cancel({ kind: 'user' })
      return true
    }
    if (matchesKey(data, 'ctrl+r')) {
      this.view.reasoning = !this.view.reasoning
      this.options.tui.requestRender()
      return true
    }
    if (matchesKey(data, 'ctrl+o')) {
      this.view.expanded = !this.view.expanded
      this.options.tui.requestRender()
      return true
    }
    return false
  }

  /**
   * Dispatch one submitted line.
   * @param text - the exact text the reader submitted.
   */
  private async submit(text: string): Promise<void> {
    const line = text.trim()
    if (line === '') return
    const commands = this.options.commands
    const agent = this.options.agent
    const known = commands !== undefined && commands.find(agent, commandNameOf(line) ?? '') !== undefined
    const submission = classifySubmission(line, known, commands !== undefined)
    if (submission.kind === 'command') {
      // The registry is what resolved this line, so it exists here.
      await this.runCommand(commands as CommandRuntime, submission.line)
      return
    }
    if (submission.kind === 'unknown-command') {
      // A user-invocable skill is invoked as `/name` and reaches the model as a
      // prompt, so the catalog decides before the line is refused. Only this
      // path pays the lookup: prompts and resolved commands never reach it.
      if (await this.namesASkill(submission.name)) {
        this.prompt(line)
        return
      }
      // Only the name is echoed: the arguments of a mistyped /credential are a secret.
      this.transcript.notice('error', `Unknown command: /${submission.name} — run /help for the list`)
      this.options.tui.requestRender()
      return
    }
    this.prompt(submission.text)
  }

  /**
   * Whether the composition serves a user-invocable skill under this name.
   *
   * A catalog that cannot be read answers `true`: forwarding a line the reader
   * meant as a skill is the recoverable failure, and refusing every skill
   * because the catalog is momentarily unavailable is not.
   * @param name - the command-shaped name the reader submitted.
   * @returns whether the line should reach the model as a skill invocation.
   */
  private async namesASkill(name: string): Promise<boolean> {
    const list = this.options.autocomplete?.skills
    if (list === undefined) return false
    try {
      return (await list(new AbortController().signal)).some(skill => skill.name === name)
    } catch {
      // The catalog read failed; nothing else in this method can throw.
      return true
    }
  }

  /**
   * Execute one resolved command. A handler that throws must not escape as an
   * unhandled rejection — that would end the process with the terminal still in
   * the alternate screen. The registry logs `command/done` before rethrowing,
   * so the transcript already carries the reason; this adds a line only when
   * the failure happened before that record existed.
   * @param commands - the registry that resolved the line.
   * @param line - the complete slash-command line.
   */
  private async runCommand(commands: CommandRuntime, line: string): Promise<void> {
    const agent = this.options.agent
    const before = agent.session.seq
    try {
      await commands.execute(agent, line, new AbortController().signal)
    } catch (error: unknown) {
      const recorded = agent.session.events
        .slice(before)
        .some(event => event.type === 'command/done')
      if (!recorded) {
        this.transcript.notice('error', error instanceof Error ? error.message : String(error))
      }
      this.options.tui.requestRender()
    }
    this.refreshStatus()
  }

  /**
   * Send one prompt to the agent: an idle agent opens a turn on it, and a
   * running agent takes it as steering for the nearest step.
   * @param text - the prompt text.
   */
  prompt(text: string): void {
    const agent = this.options.agent
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
    this.refreshStatus()
  }
}

/**
 * Read the command name out of a submitted line, without resolving it.
 * @param line - the exact text the reader submitted.
 * @returns the lowercase command name, or `undefined` when the line is not a command.
 */
export function commandNameOf(line: string): string | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  return match?.[1]
}

/**
 * Name the pane after the model this session talks to.
 * @param model - the model id requests currently use.
 * @returns the title text.
 */
export function paneTitle(model: string): string {
  return displayLine(`dsh — ${model}`)
}
