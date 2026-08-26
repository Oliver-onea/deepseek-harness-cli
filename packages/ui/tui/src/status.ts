/**
 * The status footer under the editor: what the session is doing right now, and
 * what the reader can press about it.
 * @module @deepseek-ai/dsh-tui/status
 */

import type { TodoItem } from '@deepseek-ai/dsh-session'
import { displayLine } from './display-text.ts'
import type { Palette } from './theme.ts'

/** A standing goal the reader set for this session. */
export interface StatusGoal {
  /** The goal objective, already normalized for the terminal. */
  objective: string
  /** The durable goal phase; the terminal hides completed goals. */
  phase: string
}

/** Plan-mode state as the terminal footer reads it. */
export interface StatusPlanMode {
  /** Whether plan mode is in force at the last committed step. */
  active: boolean
  /** Whether a logged /plan selection is waiting for the next accepted pre-step. */
  pending?: boolean
}

/** Everything the footer reports. */
export interface StatusInput {
  /** Whether a driver is currently running a turn. */
  running: boolean
  /** The provider route requests are going to. */
  provider: string
  /** The model id requests are going to. */
  model: string
  /** Milliseconds since the running turn woke; ignored while idle. */
  elapsedMs: number
  /** Current request pressure in tokens, from the token meter. */
  tokens: number
  /** The route's advertised context capacity, when the provider states one. */
  contextWindow: number | undefined
  /** Messages waiting in the inbox behind the running turn. */
  queued: number
  /** The latest written plan. */
  todos: readonly TodoItem[]
  /** The current session goal, when one is set and not complete. */
  goal?: StatusGoal | undefined
  /** Plan-mode state, when the composition mounts plan mode. */
  planMode?: StatusPlanMode | undefined
  /** The effective permission preset, when the composition mounts permission presets. */
  permissionPreset?: string | undefined
}

/** Milliseconds in one second, for the elapsed-time field. */
const SECOND_MS = 1000

/** Seconds in one minute, for the elapsed-time field. */
const MINUTE_SECONDS = 60

/**
 * Format elapsed time compactly enough to sit in a status field.
 * @param elapsedMs - milliseconds since the turn woke.
 * @returns the elapsed field, `12s` or `3m04s`.
 */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / SECOND_MS))
  if (seconds < MINUTE_SECONDS) return `${seconds}s`
  const minutes = Math.floor(seconds / MINUTE_SECONDS)
  return `${minutes}m${String(seconds % MINUTE_SECONDS).padStart(2, '0')}s`
}

/**
 * Format token counts the way a reader scans them.
 * @param tokens - the token count.
 * @returns the count, thousands abbreviated as `12.3k`.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}

/**
 * Describe context occupancy: the share of the route's advertised capacity the
 * current request would use. A route advertising no capacity reports the raw
 * count, because a percentage of an unknown whole would be invented.
 * @param tokens - current request pressure.
 * @param contextWindow - the advertised capacity, when known.
 * @returns the context field.
 */
export function formatContext(tokens: number, contextWindow: number | undefined): string {
  if (contextWindow === undefined) return `${formatTokens(tokens)} tokens`
  const used = Math.min(100, Math.round((tokens / contextWindow) * 100))
  return `${formatTokens(tokens)}/${formatTokens(contextWindow)} (${used}%)`
}

/**
 * Summarize the plan as counts, so a long plan still fits one field.
 * @param todos - the latest written plan.
 * @returns the plan field, or `undefined` when nothing is planned.
 */
export function formatPlan(todos: readonly TodoItem[]): string | undefined {
  if (todos.length === 0) return undefined
  const done = todos.filter(todo => todo.status === 'completed').length
  const active = todos.find(todo => todo.status === 'in_progress')
  const counts = `plan ${done}/${todos.length}`
  return active === undefined ? counts : `${counts} — ${displayLine(active.content)}`
}

/** Maximum objective length in the goal footer field; excess is truncated. */
const MAX_GOAL_OBJECTIVE_LENGTH = 40

/**
 * Summarize a standing goal for the footer. Non-active phases are named so a
 * paused or blocked goal does not read as idle work.
 * @param goal - the current session goal.
 * @returns the goal field.
 */
export function formatGoal(goal: StatusGoal): string {
  const prefix = goal.phase === 'active' ? 'goal' : `goal ${goal.phase}`
  const objective = goal.objective.length > MAX_GOAL_OBJECTIVE_LENGTH
    ? `${goal.objective.slice(0, MAX_GOAL_OBJECTIVE_LENGTH)}…`
    : goal.objective
  return `${prefix}: ${displayLine(objective)}`
}

/**
 * Summarize plan-mode state for the footer. The effective target folds a
 * pending /plan selection into the committed state, matching the web chip.
 * @param planMode - the current plan-mode state.
 * @returns the plan field, or `undefined` when plan mode is off and not pending.
 */
export function formatPlanMode(planMode: StatusPlanMode): string | undefined {
  const effective = planMode.pending ?? planMode.active
  if (!effective) return undefined
  const transitioning = planMode.pending !== undefined && planMode.pending !== planMode.active
  return transitioning ? 'plan*' : 'plan'
}

/**
 * Compose the footer line. The run state itself is carried by the footer's
 * indicator — a spinner while a turn runs, a green dot while idle — so the
 * state word here stays unstyled.
 * @param input - the current session state.
 * @param palette - the styles to draw with.
 * @returns the footer text, already normalized for the terminal.
 */
export function renderStatus(input: StatusInput, palette: Palette): string {
  const fields: string[] = []
  fields.push(input.running ? `working ${formatElapsed(input.elapsedMs)}` : 'ready')
  if (input.goal !== undefined) fields.push(palette.dim(formatGoal(input.goal)))
  const planMode = input.planMode === undefined ? undefined : formatPlanMode(input.planMode)
  if (planMode !== undefined) fields.push(palette.warn(planMode))
  if (input.permissionPreset !== undefined) fields.push(palette.dim(input.permissionPreset))
  fields.push(palette.dim(`${displayLine(input.provider)}/${displayLine(input.model)}`))
  fields.push(palette.dim(formatContext(input.tokens, input.contextWindow)))
  const plan = formatPlan(input.todos)
  if (plan !== undefined) fields.push(palette.dim(plan))
  if (input.queued > 0) fields.push(palette.warn(`${input.queued} queued`))
  // `ctrl+c` is the one interrupt that always holds: `esc` first dismisses
  // an open menu, so the running hint names the guaranteed key.
  fields.push(palette.dim(input.running ? 'ctrl+c interrupt' : '/help  ctrl+c exit'))
  return fields.join(palette.dim(' · '))
}
