/**
 * `@deepseek-ai/dsh-tui` — the full-screen terminal front door. It renders one
 * agent's session and owns terminal input; the agent, its session, its tools,
 * and the commands it answers are separate composition rows.
 *
 * The plugin requires both stdin and stdout to be TTYs and fails instead of
 * silently degrading to line-oriented output: a fallback would hide a
 * deployment mistake and change interaction semantics. Non-TTY deployments use
 * the one-shot headless app or a structured protocol.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { ProcessTerminal, TuiAltScreen, matchesKey, type Terminal, type ViewportTUI } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
// Empty type imports carry the Context merges this plugin reads optionally.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-token-meter'
import { installApprovalAnswerer } from './approval.ts'
import { TerminalQuestions } from './questions.ts'
import { createPalette } from './theme.ts'
import { TerminalShell, paneTitle } from './shell.ts'
import type { ToolOutcome } from './transcript.ts'
import type { ToolPresenter } from './view.ts'

export type { CardLayout, ToolCard } from './tool-card.ts'
export type * from './transcript.ts'

/** Stable Cordis plugin name. */
export const name = 'tui'

/**
 * The agent registry and tool registry this front door reads, plus the timer
 * behind the running turn's elapsed-time field.
 */
export const inject = ['agents', 'timer', 'tools']

/** How often the footer redraws while a turn runs, so elapsed time advances. */
const STATUS_INTERVAL_MS = 1000

/** Lines kept at the head of a folded tool-card body when nothing states otherwise. */
const DEFAULT_HEAD_LINES = 8

/** Lines kept at the tail of a folded tool-card body when nothing states otherwise. */
const DEFAULT_TAIL_LINES = 4

/** Plugin config. */
export interface Config {
  /** The exact session id of the agent this terminal drives, as created by the host. */
  session: string
  /** Whether to style output; `false` renders the same layout without SGR sequences. */
  color?: boolean
  /** Lines kept at the head of a folded tool-card body. */
  headLines?: number
  /** Lines kept at the tail of a folded tool-card body. */
  tailLines?: number
  /** Whether reasoning starts visible; a terminal control toggles it either way. */
  showReasoning?: boolean
  /** A first prompt to submit once the screen is up, for `dsh "<task>"`. */
  task?: string
}

export const Config: z<Config> = z.object({
  session: z.string().required(),
  color: z.boolean().default(true),
  headLines: z.natural().default(DEFAULT_HEAD_LINES),
  tailLines: z.natural().default(DEFAULT_TAIL_LINES),
  showReasoning: z.boolean().default(false),
  task: z.string(),
})

/** The terminal settings after defaulting: what {@link TerminalShell} reads. */
export interface ResolvedConfig {
  /** Whether to style output. */
  color: boolean
  /** Lines kept at the head of a folded tool-card body. */
  headLines: number
  /** Lines kept at the tail of a folded tool-card body. */
  tailLines: number
  /** Whether reasoning starts visible. */
  showReasoning: boolean
}

/**
 * Resolve the terminal settings. The Loader validates through {@link Config},
 * whose schema defaults already fill these in; this step states the same
 * defaults for a caller that mounts the plugin directly, and is the one place
 * that decides them.
 * @param config - the validated plugin config.
 * @returns the settings the shell runs on.
 */
export function resolveTerminalConfig(config: Config): ResolvedConfig {
  return {
    color: config.color ?? true,
    headLines: config.headLines ?? DEFAULT_HEAD_LINES,
    tailLines: config.tailLines ?? DEFAULT_TAIL_LINES,
    showReasoning: config.showReasoning ?? false,
  }
}

/**
 * Whether this process may take over the terminal: both streams must be TTYs,
 * because the renderer reads raw keys from one and repaints the other.
 * @returns whether a full-screen takeover is possible.
 */
export function isInteractiveProcess(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY
}

/**
 * Process-facing effects, substituted by tests that drive the shell without a
 * real terminal.
 */
export const internals: {
  /** Whether the current process may take over the terminal. */
  interactive(): boolean
  /** Build the terminal this front door draws on. */
  createTerminal(): Terminal
} = {
  interactive: isInteractiveProcess,
  createTerminal: () => new ProcessTerminal(),
}

/**
 * Resolve the agent for `session`, waiting for its creation when the loop has
 * not published it yet.
 * @param ctx - plugin context carrying the agent registry.
 * @param session - the session id the host created its agent with.
 * @returns the live agent, or `undefined` when the tree disposes first.
 */
function whenAgent(ctx: Context, session: SessionId): Promise<Agent | undefined> {
  const existing = ctx.agents.get(session)
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise<Agent | undefined>((resolve) => {
    const stop = ctx.on('agent/created', ({ agent }) => {
      if (agent.session.id !== session) return
      stop()
      resolve(agent)
    })
    // Disposal before the agent arrives settles the wait, so a torn-down tree
    // never leaves this plugin holding a promise nothing will resolve.
    ctx.effect(function* () {
      yield () => {
        stop()
        resolve(undefined)
      }
    }, 'dsh-tui.agent-wait')
  })
}

/**
 * Build the tool-view lookups over the agent's own scope chain, so a preset's
 * tools present through the definitions that agent actually sees. A throwing
 * presenter or unparseable arguments fall back to no view rather than taking
 * the screen down.
 * @param ctx - plugin context carrying the tool registry.
 * @param agent - the agent whose scope resolves tool definitions.
 * @returns the presenter the transcript view reads through.
 */
export function createPresenter(ctx: Context, agent: Agent): ToolPresenter {
  const definition = (name_: string): ReturnType<Context['tools']['get']> => ctx.tools.get(name_, agent)
  return {
    presentCall(name_: string, rawArguments: string): ToolCallView | undefined {
      try {
        return definition(name_)?.presentCall?.(JSON.parse(rawArguments))
      } catch {
        // A tool that cannot present its own call still renders as its name.
        return undefined
      }
    },
    presentResult(name_: string, rawArguments: string, outcome: ToolOutcome): ToolResultView | undefined {
      try {
        return definition(name_)?.presentResult?.(JSON.parse(rawArguments), {
          content: outcome.content,
          isError: outcome.isError,
          ...outcome.meta === undefined ? {} : { meta: outcome.meta },
        })
      } catch {
        // Falling back to the raw result keeps the outcome visible.
        return undefined
      }
    },
  }
}

/**
 * Resolve the route this session's requests use: what the composition
 * configured for this agent, else the deployment default. A route with neither
 * leaves the selection unset, and the adapter's own default answers.
 * @param agent - the agent this terminal drives.
 * @param fallback - the deployment default selection, when a service supplies one.
 * @returns the selection to install, or `undefined` when nothing names a route.
 */
export function resolveSelection(
  agent: Agent,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  const { provider, model } = agent.options
  if (provider === undefined || model === undefined) return fallback
  return { provider, model }
}

/**
 * Mount the terminal front door.
 * @param ctx - plugin context carrying the agent and tool registries.
 * @param config - validated terminal config.
 */
export function apply(ctx: Context, config: Config): void {
  if (!internals.interactive()) {
    throw new Error('dsh-tui: the terminal front door needs a TTY on both stdin and stdout; use the headless app for pipes and automation')
  }
  void start(ctx, config).catch((error: unknown) => {
    ctx.logger.error(`dsh-tui: ${error instanceof Error ? error.message : String(error)}`)
    ctx.get('appExit')?.(1)
  })
}

/**
 * Wait for the agent, then take the screen. Screen takeover happens only after
 * the agent exists, so a failed startup is reported to an ordinary terminal
 * rather than behind an alternate screen.
 * @param ctx - plugin context carrying the registries and optional services.
 * @param config - validated terminal config.
 */
async function start(ctx: Context, config: Config): Promise<void> {
  const agent = await whenAgent(ctx, SessionId(config.session))
  if (agent === undefined) return

  const settings = resolveTerminalConfig(config)
  const palette = createPalette(settings.color)
  const defaultRoute = ctx.get('agentDefaultModel')?.currentSelection()
  // The selection is agent-scoped state this front door owns: it fills the
  // persona's `{{provider}}`/`{{model}}` variables and routes each request, and
  // it is where a terminal model picker would write.
  const selection: ModelSelectionRef = {
    current: resolveSelection(agent, defaultRoute),
    assembled: undefined,
  }
  installModelSelection(agent.ctx, selection)
  const terminal = internals.createTerminal()
  const tui: ViewportTUI = new TuiAltScreen(terminal)
  const shell = new TerminalShell({
    tui,
    agent,
    palette,
    presenter: createPresenter(ctx, agent),
    commands: ctx.get('commands'),
    tokenMeter: ctx.get('tokenMeter'),
    headLines: settings.headLines,
    tailLines: settings.tailLines,
    showReasoning: settings.showReasoning,
    defaultRoute,
  })

  ctx.effect(function* () {
    tui.start()
    shell.start()
    terminal.setTitle(paneTitle(shell.model))
    yield () => { tui.stop() }
  }, 'dsh-tui.screen')

  // Replay the durable log the host resumed before following live appends, so
  // the reader sees the conversation they are continuing.
  for (const event of agent.session.events) shell.observe(event)
  shell.refreshStatus()

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    shell.observe(event)
  })
  ctx.on('agent/status', (payload) => {
    if (payload.agent === agent) shell.refreshStatus()
  })
  ctx.interval(() => {
    if (agent.status === 'running') shell.refreshStatus()
  }, STATUS_INTERVAL_MS)

  const questions = new TerminalQuestions(shell, palette)
  ctx.inject(['userQuestions'], (scope: Context) => {
    scope.userQuestions.registerProvider(questions)
  })
  ctx.inject(['approval'], (scope: Context) => {
    installApprovalAnswerer(scope, agent, request => questions.ask(request))
  })

  const leave = (): void => { void quit(agent, () => { ctx.get('appExit')?.(0) }) }
  ctx.inject(['commands'], (scope: Context) => {
    for (const command of ['exit', 'quit']) {
      scope.commands.register({
        name: command,
        description: 'Leave the terminal session',
        handler: () => {
          leave()
          return { kind: 'success', text: 'Leaving.' }
        },
      })
    }
  })

  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      // The first interrupt stops the turn; a second one, with nothing to
      // stop, leaves the terminal.
      if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
        return { consume: true }
      }
      leave()
      return { consume: true }
    }
    return shell.handleKey(data) ? { consume: true } : undefined
  })

  if (config.task !== undefined && config.task.trim() !== '') shell.prompt(config.task)
}

/**
 * Leave the terminal session: stop any running turn, wait for the agent to
 * settle so its session flushes, then request process exit.
 * @param agent - the agent this terminal drives.
 * @param exit - the launcher's bounded exit request.
 */
async function quit(agent: Agent, exit: () => void): Promise<void> {
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  exit()
}
