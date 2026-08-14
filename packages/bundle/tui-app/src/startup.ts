/**
 * The terminal app's command-line provider: it parses the `dsh` flag family
 * (`--resume`, `--model`, `--provider`, `--no-color`) plus an optional first
 * task, then provides the resolved invocation as {@link TUI_STARTUP_SERVICE}.
 * The agent row and the terminal row inject that service before reading it
 * from lazy config.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { StartupRefusalError } from '@deepseek-ai/dsh-app-boot/errors'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags and any resume target can be resolved. */
export const inject = ['cmdlineArgs', 'sessionPersistence']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** One configured `agent-loop` entry, fresh or resumed. */
export interface StartupAgent {
  /** Stable config label for logs and the fresh combined-id prefix. */
  id: string
  /** Identity for a fresh session; absent when resuming. */
  sessionId?: string
  /** Persisted session to resume; absent for a fresh session. */
  resumeSessionId?: string
  /** Provider route, when the invocation named one. */
  provider?: string
  /** Model id, when the invocation named one. */
  model?: string
  /** Workspace for a fresh session. */
  cwd?: string
}

/** What the terminal rows read from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The exact session id the terminal attaches to, fresh or resumed. */
  session: string
  /** The single configured agent entry, ready for `agent-loop`'s `agents` list. */
  agent: StartupAgent
  /** Whether output is styled; `--no-color` turns it off. */
  color: boolean
  /** A first prompt to submit once the screen is up, when the invocation carried one. */
  task?: string
}

/** The terminal flag family, as commander parsed it. */
interface TuiOptions {
  resume?: string
  model?: string
  provider?: string
  color?: boolean
}

/** Config label for the one agent this app composes. */
const AGENT_ID = 'tui'

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh')
    .description('Open the DeepSeek Harness terminal. With a task, the session starts by answering it.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'a first task; multiple words are joined by spaces')
    .option('--resume <session>', 'continue a persisted session instead of starting a fresh one')
    .option('--model <model>', 'model id for this session')
    .option('--provider <provider>', 'provider route for this session')
    .option('--no-color', 'render without ANSI styling')
    .addHelpText('after', `
Examples:
  dsh                                        open an empty terminal session
  dsh "run the tests"                        open the terminal and start on that task
  dsh --resume <session>                     continue where a previous session stopped
`)
}

/**
 * Resolve the invocation into the values the terminal rows read.
 * @param options - the flags commander collected.
 * @param task - the joined task positional, empty when the invocation carried none.
 * @param cwd - the workspace a fresh session is created in.
 * @returns the immutable startup values.
 */
export function resolveStartup(options: TuiOptions, task: string, cwd: string): TuiStartupValues {
  const resume = options.resume
  // A resumed session keeps its own id; a fresh one is minted here so the
  // terminal row and the agent row name the same session without either
  // depending on the other's mount order.
  const session = resume === undefined || resume === '' ? `session-${randomUUID()}` : resume
  const agent: StartupAgent = {
    id: AGENT_ID,
    ...resume === undefined || resume === ''
      ? { sessionId: session, cwd }
      : { resumeSessionId: session },
    ...options.provider === undefined ? {} : { provider: options.provider },
    ...options.model === undefined ? {} : { model: options.model },
  }
  return {
    session,
    agent,
    color: options.color !== false,
    ...task.trim() === '' ? {} : { task },
  }
}

/** Render an error caught at the persistence boundary for a startup refusal. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse and provide the terminal invocation as an ordinary Cordis service. A
 * requested resume target is inspected through the configured persistence
 * backend before dependent rows can activate. On `--help` the action never
 * runs, so no service is provided and no agent or screen is composed.
 * @param ctx - plugin context carrying the command line.
 * @returns once any resume target is known to be readable and the startup
 * values have been published.
 */
export async function apply(ctx: Context): Promise<void> {
  const program = tuiCommand()
  let startup: TuiStartupValues | undefined
  program.action(() => {
    const options = program.opts<TuiOptions>()
    if (options.resume === '') program.error('error: --resume needs a session id')
    startup = resolveStartup(options, program.args.join(' '), process.cwd())
  })
  parseCmdline(ctx, program)
  if (startup === undefined) return
  const resume = startup.agent.resumeSessionId
  if (resume !== undefined) {
    try {
      await ctx.sessionPersistence.inspect(SessionId(resume))
    } catch (error) {
      throw new StartupRefusalError(
        `dsh: cannot resume session ${JSON.stringify(resume)}: ${errorMessage(error)}; check the session id and stored log, or omit --resume to start a new session`,
        { cause: error },
      )
    }
  }
  ctx.provide(TUI_STARTUP_SERVICE, startup)
}
