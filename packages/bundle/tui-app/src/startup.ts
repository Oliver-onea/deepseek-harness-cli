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
import { pickResumeSession, resumeCandidates, type PickerStdin, type PickerStdout, type ResumePickerOutcome } from '@deepseek-ai/dsh-tui'
import type { SessionHeader } from '@deepseek-ai/dsh-session-persistence'

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
  /** Session id to resume, or `true` when `--resume` named none. */
  resume?: string | true
  model?: string
  provider?: string
  color?: boolean
}

/** The flag subset {@link resolveStartup} consumes: a resume target, never the picker request. */
interface ResolvedFlags {
  resume?: string
  model?: string
  provider?: string
  color?: boolean
}

/** Config label for the one agent this app composes. */
const AGENT_ID = 'tui'

/**
 * Process-facing facts the launch picker reads; substituted by tests that
 * drive a bare `--resume` without a real terminal.
 */
export const internals: {
  /** The stdin picker keys arrive on. */
  stdin: PickerStdin
  /** The stdout the picker draws on. */
  stdout: PickerStdout
  /** Whether both streams are TTYs, the precondition a picker needs. */
  interactive(): boolean
} = {
  stdin: process.stdin,
  stdout: process.stdout,
  interactive: () => process.stdin.isTTY && process.stdout.isTTY,
}

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
    .option('--resume [session]', 'continue a persisted session; with no session named, pick one at launch')
    .option('--model <model>', 'model id for this session')
    .option('--provider <provider>', 'provider route for this session')
    .option('--no-color', 'render without ANSI styling')
    .addHelpText('after', `
Examples:
  dsh                                        open an empty terminal session
  dsh "run the tests"                        open the terminal and start on that task
  dsh --resume <session>                     continue where a previous session stopped
  dsh --resume                               pick a previous session from a list
`)
}

/**
 * Resolve the invocation into the values the terminal rows read.
 * @param options - the flags commander collected, with any picker request already resolved to an id.
 * @param task - the joined task positional, empty when the invocation carried none.
 * @param cwd - the workspace a fresh session is created in.
 * @returns the immutable startup values.
 */
export function resolveStartup(options: ResolvedFlags, task: string, cwd: string): TuiStartupValues {
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
 * Resolve the resume target a bare `--resume` asked for, through the launch
 * picker on the ordinary terminal: list the store's top-level sessions, let
 * the reader pick one, and hand back its id. Every way the picker cannot
 * produce a target — no TTY, an unlistable store, nothing to offer, a
 * terminal too small to draw a row, or a dismissed list — refuses startup
 * before any dependent row activates, so nothing is resumed and no session
 * is created by surprise.
 * @param ctx - plugin context carrying the persistence backend.
 * @param color - whether the picker styles its rows, from the invocation's flags.
 * @returns the picked session id.
 */
async function pickResumeTarget(ctx: Context, color: boolean): Promise<string> {
  if (!internals.interactive()) {
    throw new StartupRefusalError(
      'dsh: --resume without a session id opens a picker and needs a TTY on both stdin and stdout; name the session explicitly with dsh --resume <session>',
    )
  }
  let headers: SessionHeader[]
  try {
    headers = await ctx.sessionPersistence.list()
  } catch (error) {
    throw new StartupRefusalError(
      `dsh: cannot list persisted sessions: ${errorMessage(error)}; name the session explicitly with dsh --resume <session>`,
      { cause: error },
    )
  }
  const candidates = resumeCandidates(headers)
  if (candidates.length === 0) {
    throw new StartupRefusalError(headers.length === 0
      ? 'dsh: there are no persisted sessions to resume; run dsh without --resume to start a fresh one'
      : 'dsh: only subagent child sessions are persisted, and a child is not a conversation to resume; run dsh without --resume to start a fresh one')
  }
  // A teardown while the picker holds the terminal aborts it, so its raw-mode
  // stdin cannot outlive the tree or hold the process open. The abort rides
  // `internal/plugin` because Cordis runs effect cleanup only after this
  // callback settles: an async plugin must observe its own disposal or unload
  // would wait on the picker forever.
  const abort = new AbortController()
  const stopCancellation = ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) abort.abort()
  })
  let outcome: ResumePickerOutcome
  try {
    outcome = await pickResumeSession({
      candidates,
      color,
      stdin: internals.stdin,
      stdout: internals.stdout,
      signal: abort.signal,
    })
  } finally {
    stopCancellation()
  }
  if (outcome.kind === 'picked') return outcome.candidate.id
  throw new StartupRefusalError(outcome.kind === 'too-small'
    ? 'dsh: the terminal is too small for the resume picker; name the session explicitly with dsh --resume <session>'
    : 'dsh: no session chosen; run dsh to start a fresh session or name one with dsh --resume <session>')
}

/**
 * Parse and provide the terminal invocation as an ordinary Cordis service. A
 * requested resume target is inspected through the configured persistence
 * backend before dependent rows can activate — a target the launch picker
 * produced goes through the same inspection a named one does. On `--help` the
 * action never runs, so no service is provided and no agent or screen is
 * composed.
 * @param ctx - plugin context carrying the command line.
 * @returns once any resume target is known to be readable and the startup
 * values have been published.
 */
export async function apply(ctx: Context): Promise<void> {
  const program = tuiCommand()
  let invocation: { options: TuiOptions; task: string } | undefined
  program.action(() => {
    const options = program.opts<TuiOptions>()
    if (options.resume === '') program.error('error: --resume needs a session id')
    invocation = { options, task: program.args.join(' ') }
  })
  parseCmdline(ctx, program)
  if (invocation === undefined) return
  const { options, task } = invocation
  const resumeId = options.resume === true
    ? await pickResumeTarget(ctx, options.color !== false)
    : options.resume
  // `--resume` with no value arrives as `true`; the picker resolved it above, so
  // the raw flag never reaches the resolved-flag record.
  const { resume: _requested, ...flags } = options
  const startup = resolveStartup(
    { ...flags, ...resumeId === undefined ? {} : { resume: resumeId } },
    task,
    process.cwd(),
  )
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
