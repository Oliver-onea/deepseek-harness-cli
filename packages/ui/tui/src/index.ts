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
import { StartupRefusalError } from '@deepseek-ai/dsh-app-boot/errors'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
// Empty type imports carry the Context merges this plugin reads optionally.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter'
import { installApprovalAnswerer } from './approval.ts'
import { childDisplayName, childRunning, type MenuSkill, type RunningChild } from './autocomplete.ts'
import { helpText } from './command-help.ts'
import { runModelCommand } from './model-picker.ts'
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

/** Candidate rows the input-trigger menus show before scrolling, by default. */
const DEFAULT_MAX_SUGGESTIONS = 8

/** Default bound for waiting on the composition's configured agent. */
export const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 30_000
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
  /** Maximum time to wait for the configured agent before refusing startup. */
  agentWaitTimeoutMs?: number
  /** Candidate rows the `/` and `@` menus show before scrolling. */
  maxSuggestions?: number
}

export const Config: z<Config> = z.object({
  session: z.string().required(),
  color: z.boolean().default(true),
  headLines: z.natural().default(DEFAULT_HEAD_LINES),
  tailLines: z.natural().default(DEFAULT_TAIL_LINES),
  showReasoning: z.boolean().default(false),
  task: z.string(),
  agentWaitTimeoutMs: z.number().step(1).min(1).default(DEFAULT_AGENT_WAIT_TIMEOUT_MS),
  maxSuggestions: z.natural().min(1).default(DEFAULT_MAX_SUGGESTIONS),
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
  /** Maximum time to wait for the configured agent. */
  agentWaitTimeoutMs: number
  /** Candidate rows the `/` and `@` menus show before scrolling. */
  maxSuggestions: number
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
    agentWaitTimeoutMs: config.agentWaitTimeoutMs ?? DEFAULT_AGENT_WAIT_TIMEOUT_MS,
    maxSuggestions: config.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS,
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
 * not published it yet, but never beyond the configured startup deadline.
 * @param ctx - plugin context carrying the agent registry.
 * @param session - the session id the host created its agent with.
 * @param timeoutMs - maximum time to wait for publication.
 * @returns the live agent, or `undefined` when the tree disposes first.
 * @throws {@link StartupRefusalError} when the deadline expires.
 */
function whenAgent(ctx: Context, session: SessionId, timeoutMs: number): Promise<Agent | undefined> {
  const existing = ctx.agents.get(session)
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise<Agent | undefined>((resolve, reject) => {
    let settled = false
    const finish = (agent: Agent | undefined, error?: StartupRefusalError): void => {
      if (settled) return
      settled = true
      stop()
      stopTimeout()
      if (error === undefined) resolve(agent)
      else reject(error)
    }
    const stop = ctx.on('agent/created', ({ agent }) => {
      if (agent.session.id !== session) return
      finish(agent)
    })
    const stopTimeout = ctx.timeout(() => {
      finish(undefined, new StartupRefusalError(
        `dsh-tui: agent for session ${JSON.stringify(session)} did not appear within ${String(timeoutMs)}ms; check the agent composition or increase agentWaitTimeoutMs`,
      ))
    }, timeoutMs)
    // Disposal before the agent arrives settles the wait, so a torn-down tree
    // never leaves this plugin holding a promise nothing will resolve.
    ctx.effect(function* () {
      yield () => {
        finish(undefined)
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
 * Resolve the route this session's requests use when nothing stronger names
 * one: what the composition configured for this agent, else the deployment
 * default. A route with neither leaves the selection unset, and the adapter's
 * own default answers.
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
 * Build the model selection this terminal installs on its agent, resolved on
 * every read: a pick made in this process, else the session's last logged
 * request header, else the creation pin or deployment default. The live read
 * restores a resumed session's switched route from its log — the precedence
 * the web surface's selection follows — and lets a blank session read a
 * default saved after it was created.
 * @param agent - the agent this terminal drives.
 * @param defaultRoute - the deployment default, read live on every read.
 * @returns the mutable selection prompt assembly snapshots.
 */
export function liveSelection(
  agent: Agent,
  defaultRoute: () => ModelSelection | undefined,
): ModelSelectionRef {
  let picked: ModelSelection | undefined
  return {
    get current(): ModelSelection | undefined {
      if (picked !== undefined) return picked
      const logged = agent.session.requestHeader()?.config
      if (logged !== undefined) {
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
        }
      }
      return resolveSelection(agent, defaultRoute())
    },
    set current(next: ModelSelection | undefined) {
      picked = next
    },
    assembled: undefined,
  }
}

/**
 * Mount the terminal front door.
 * @param ctx - plugin context carrying the agent and tool registries.
 * @param config - validated terminal config.
 * @returns once the screen has mounted or startup has been refused.
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  if (!internals.interactive()) {
    throw new StartupRefusalError('dsh-tui: the terminal front door needs a TTY on both stdin and stdout; use the headless app for pipes and automation')
  }
  return start(ctx, config).catch((error: unknown) => {
    if (error instanceof StartupRefusalError) throw error
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
  const settings = resolveTerminalConfig(config)
  const agent = await whenAgent(ctx, SessionId(config.session), settings.agentWaitTimeoutMs)
  if (agent === undefined) return

  const palette = createPalette(settings.color)
  const defaultRoute = ctx.get('agentDefaultModel')?.currentSelection()
  // The selection is agent-scoped state this front door owns: it fills the
  // persona's `{{provider}}`/`{{model}}` variables and routes each request.
  // A pick writes it; a resumed session's log outranks the launch pin; the
  // deployment default answers when neither names a route.
  const selection = liveSelection(agent, () => ctx.get('agentDefaultModel')?.currentSelection())
  installModelSelection(agent.ctx, selection)
  const terminal = internals.createTerminal()
  const tui: ViewportTUI = new TuiAltScreen(terminal)
  const goals = ctx.get('goals')
  const planMode = ctx.get('planMode')
  const permissionPresets = ctx.get('permissionPresets')
  const commands = ctx.get('commands')
  const skills = ctx.get('skills')
  const subagents = ctx.get('subagents')
  const llm = ctx.get('llm')
  const shell = new TerminalShell({
    tui,
    agent,
    palette,
    presenter: createPresenter(ctx, agent),
    commands,
    tokenMeter: ctx.get('tokenMeter'),
    goal: goals === undefined ? undefined : () => {
      const view = goals.get(agent)
      return view === undefined || view.phase === 'complete'
        ? undefined
        : { objective: view.objective, phase: view.phase }
    },
    planMode: planMode === undefined ? undefined : () => planMode.get(agent),
    permissionPreset: permissionPresets === undefined
      ? undefined
      : () => permissionPresets.current(agent.session.events),
    headLines: settings.headLines,
    tailLines: settings.tailLines,
    showReasoning: settings.showReasoning,
    defaultRoute,
    autocomplete: {
      commands: commands === undefined ? () => [] : () => commands.list(agent),
      // The catalog read resolves the agent's own scope chain and project cwd,
      // the same lookup the web host serves as `skill.list`; only
      // user-invocable skills reach the menu, because only those answer a
      // pick. Reads ride the registry's revision-keyed cache, so a skill
      // registered or removed after the screen is up shows on the next query.
      skills: skills === undefined ? undefined : async (signal): Promise<readonly MenuSkill[]> => {
        const listed = await skills.list({ cwd: agent.session.header.cwd, signal, scope: agent })
        return listed.flatMap(skill => skill.invocation.userInvocable
          ? [{ name: skill.name, description: skill.description, modelInvocable: skill.invocation.modelInvocable }]
          : [])
      },
      subagents: subagents === undefined ? undefined : async (signal): Promise<readonly RunningChild[]> => {
        const children = await subagents.listChildren(agent.session.id, signal)
        return children.flatMap((entry) => {
          const live = ctx.agents.get(entry.id)
          return childRunning(entry, live) ? [{ name: childDisplayName(entry, live) }] : []
        })
      },
      maxVisible: settings.maxSuggestions,
    },
  })

  ctx.effect(function* () {
    tui.start()
    shell.start()
    terminal.setTitle(paneTitle(shell.model))
    yield () => { tui.stop() }
  }, 'dsh-tui.screen')
  /** Restate the pane title after every route change the shell knows about. */
  const syncTitle = (): void => { terminal.setTitle(paneTitle(shell.model)) }

  // Replay the durable log the host resumed before following live appends, so
  // the reader sees the conversation they are continuing. The replayed
  // request/context restates the route the session actually used last, so the
  // footer and pane title name it rather than the launch pin.
  for (const event of agent.session.events) shell.observe(event)
  shell.refreshStatus()
  syncTitle()

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    shell.observe(event)
    if (event.type === 'request/context') syncTitle()
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
    scope.commands.register({
      name: 'help',
      description: 'List the commands this terminal resolves',
      handler: ({ agent: receiving }) => ({
        kind: 'success',
        text: helpText(scope.commands.list(receiving)),
      }),
    })
    // The switch acts on this terminal's own agent and the selection this
    // front door installed, not on whichever agent's UI dispatched the line.
    scope.commands.register({
      name: 'model',
      description: 'Show or switch the model this session uses',
      input: { hint: '[provider/model]' },
      handler: ({ rawInput }) => runModelCommand({
        llm,
        selection,
        host: shell,
        palette,
        rows: () => terminal.rows,
        maxVisible: settings.maxSuggestions,
        imageSurface: () => ({
          pending: [...agent.inbox.nextTurn, ...agent.inbox.nextStep],
          logged: agent.session.deriveMessages(),
        }),
        persist: next => Promise.resolve(ctx.get('agentDefaultModel')?.saveSelection(next)),
        onApplied: (provider, model) => {
          shell.noteRoute(provider, model)
          syncTitle()
        },
      }, rawInput),
    })
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
