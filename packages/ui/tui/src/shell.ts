/**
 * The terminal shell: the layout, key routing, and input plumbing that turn one
 * live agent into a full-screen conversation. It owns presentation only —
 * turns, persistence, tools, and commands stay with their own services.
 * @module @deepseek-ai/dsh-tui/shell
 */

import {
  Editor,
  ScrollView,
  Text,
  VStack,
  matchesKey,
  type Component,
  type ViewportTUI,
} from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { displayLine } from './display-text.ts'
import type { PanelHost } from './questions.ts'
import { renderStatus } from './status.ts'
import type { Palette } from './theme.ts'
import { Transcript } from './transcript.ts'
import { TranscriptView, type ToolPresenter } from './view.ts'

/** Everything the shell needs from the composition around it. */
export interface ShellOptions {
  /** The renderer this shell draws through. */
  tui: ViewportTUI
  /** The single agent this terminal drives. */
  agent: Agent
  /** The styles to draw with. */
  palette: Palette
  /** The tool-view lookups the transcript uses. */
  presenter: ToolPresenter
  /** The slash-command registry, when the composition mounts one. */
  commands: CommandRuntime | undefined
  /** The token meter behind the context field, when the composition mounts one. */
  tokenMeter: TokenMeter | undefined
  /** Lines kept at the head of a folded tool-card body. */
  headLines: number
  /** Lines kept at the tail of a folded tool-card body. */
  tailLines: number
  /** Whether reasoning starts visible. */
  showReasoning: boolean
  /**
   * The deployment's default route, shown until the session's first request
   * logs the one it actually used. Absent when the composition mounts no
   * default-model service.
   */
  defaultRoute: { provider: string; model: string } | undefined
}

/** The editor's placeholder-free border styling. */
const EDITOR_PADDING_X = 1

/**
 * Route one submitted line: a slash command the registry knows runs as a
 * command, and everything else is conversation.
 */
type Submission =
  | { kind: 'command'; line: string }
  | { kind: 'prompt'; text: string }

/**
 * Classify a submitted line without dispatching it.
 * @param line - the exact text the reader submitted.
 * @param known - whether the registry resolves this line to a command.
 * @returns how the line should be handled.
 */
export function classifySubmission(line: string, known: boolean): Submission {
  return known ? { kind: 'command', line } : { kind: 'prompt', text: line }
}

/** The live terminal conversation. */
export class TerminalShell implements PanelHost {
  private readonly transcript = new Transcript()
  private readonly view: TranscriptView
  private readonly editor: Editor
  private readonly status = new Text('', EDITOR_PADDING_X, 0)
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
    })
    this.view.reasoning = options.showReasoning
    this.view.layout = { headLines: options.headLines, tailLines: options.tailLines, expanded: false }
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
        component: new VStack([this.editor, this.status]),
        basis: 'auto',
        shrink: 1,
        minSize: 1,
      },
    ]))
    tui.setFocus(this.editor)
    this.refreshStatus()
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
    this.status.setText(renderStatus({
      running: agent.status === 'running',
      provider: this.route.provider,
      model: this.route.model,
      elapsedMs: this.turnStartedAt === undefined ? 0 : Date.now() - this.turnStartedAt,
      tokens: measurement?.totalTokens ?? 0,
      contextWindow: this.contextWindow,
      queued: agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
      todos: this.transcript.todos,
    }, this.options.palette))
    this.options.tui.requestRender()
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

  /** Ask the renderer to draw again. */
  requestRender(): void {
    this.options.tui.requestRender()
  }

  /**
   * Handle the terminal-only controls. Keys that belong to a live panel or to
   * the editor are not claimed here.
   * @param data - the raw input sequence.
   * @returns whether this shell consumed the key.
   */
  handleKey(data: string): boolean {
    if (this.panels.size > 0) return false
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
    const submission = classifySubmission(line, known)
    if (submission.kind === 'command') {
      // The registry is what resolved this line, so it exists here.
      await (commands as CommandRuntime).execute(agent, submission.line, new AbortController().signal)
      this.refreshStatus()
      return
    }
    this.prompt(submission.text)
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
