/**
 * The `/model` command: read the live model catalog through the `llm` service
 * — the same registry the web host serves as `session.models` — and switch the
 * route this terminal's `ModelSelectionRef` hands to prompt assembly, then
 * persist the pick as the deployment default the way the web surface does.
 * With no argument it opens a keyboard panel whose rows drill into an effort
 * tier for the routes whose adapters advertise reasoning efforts; with
 * arguments it selects directly, optionally naming an effort.
 * @module @deepseek-ai/dsh-tui/model-picker
 */

import { matchesKey, type Component } from '@earendil-works/pi-tui'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { contentHasImage, type ContentBlock, type LlmRuntime, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { menuRowsFor } from './autocomplete.ts'
import { displayLine } from './display-text.ts'
import { DIRECT_SELECT_LIMIT, type PanelHost } from './questions.ts'
import type { Palette } from './theme.ts'

/** Efforts one advertised route supports, read from its adapter's declaration. */
export interface CandidateReasoning {
  /** Supported efforts in adapter order; the default need not be first. */
  readonly efforts: readonly { readonly id: ReasoningEffortId; readonly name: string }[]
  /** Adapter-configured default applied when no effort is selected, when declared. */
  readonly defaultEffort: ReasoningEffortId | undefined
}

/** One selectable route the catalog advertised. */
export interface ModelCandidate {
  /** Registered provider route id, used to route requests. */
  readonly provider: string
  /** Provider-owned model id, used to route requests. */
  readonly model: string
  /** Provider-supplied display name, sanitized for one terminal row. */
  readonly name: string
  /** Adapter-declared reasoning efforts, absent when the route offers none. */
  readonly reasoning: CandidateReasoning | undefined
}

/** The catalog read one `/model` invocation lists. */
export interface ModelCatalog {
  /** Advertised routes, providers in registration order, models in provider order. */
  readonly candidates: readonly ModelCandidate[]
  /** Sanitized per-provider listing failures; advertised routes remain usable. */
  readonly failures: readonly string[]
}

/**
 * List the routes every registered provider advertises, mirroring what the web
 * host serves as `session.models`: each provider lists independently — models
 * first, then each model's exact-route reasoning declaration — a failing
 * provider rides {@link ModelCatalog.failures} without failing the sound
 * ones, and a provider advertising nothing contributes nothing.
 * @param llm - the adapter registry this composition mounts.
 * @returns the catalog the picker draws and direct selection matches against.
 */
export async function modelCandidates(llm: LlmRuntime): Promise<ModelCatalog> {
  const candidates: ModelCandidate[] = []
  const failures: string[] = []
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      for (const info of models) {
        const resolved = await llm.resolveModelInfo(provider.id, info.id)
        const reasoning = resolved.reasoning
        candidates.push({
          provider: provider.id,
          model: info.id,
          name: displayLine(info.name),
          reasoning: reasoning === undefined ? undefined : {
            efforts: reasoning.efforts.map(effort => ({ id: effort.id, name: displayLine(effort.name) })),
            defaultEffort: reasoning.defaultEffort,
          },
        })
      }
    } catch (error: unknown) {
      failures.push(displayLine(`${provider.id}: ${errorText(error)}`))
    }
  }
  return { candidates, failures }
}

/** What matching one `/model` argument against the catalog found. */
export type CandidateMatch =
  | { kind: 'candidate'; candidate: ModelCandidate }
  | { kind: 'ambiguous'; model: string; providers: string[] }

/**
 * Match one `/model` route argument against the catalog: `provider/model`
 * names one route, a bare model id must be unique across providers.
 * @param candidates - the advertised routes.
 * @param query - the exact argument text after the command name.
 * @returns the match found, or `undefined` when nothing advertises it.
 */
export function findCandidate(candidates: readonly ModelCandidate[], query: string): CandidateMatch | undefined {
  const trimmed = query.trim()
  if (trimmed === '') return undefined
  const separator = trimmed.indexOf('/')
  if (separator > 0) {
    const exact = candidates.find(
      candidate => candidate.provider === trimmed.slice(0, separator) && candidate.model === trimmed.slice(separator + 1),
    )
    return exact === undefined ? undefined : { kind: 'candidate', candidate: exact }
  }
  const byModel = candidates.filter(candidate => candidate.model === trimmed)
  const unique = byModel.length === 1 ? byModel.at(0) : undefined
  if (unique !== undefined) return { kind: 'candidate', candidate: unique }
  if (byModel.length > 1) {
    return { kind: 'ambiguous', model: trimmed, providers: [...new Set(byModel.map(candidate => candidate.provider))] }
  }
  return undefined
}

/** The effort an explicit pick requests for its route. */
export type EffortRequest =
  | { kind: 'default' }
  | { kind: 'effort'; id: ReasoningEffortId }

/** The argument that asks a route for its adapter's default effort. */
const DEFAULT_EFFORT_ARGUMENT = 'default'

/**
 * Render a rejection's message without trusting its coercion.
 * @param error - a rejection the adapter registry or persistence produced.
 * @returns the message to show the reader.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve one `/model` effort argument against the route's adapter-declared
 * efforts, failing loud at pick time — never at request time — when the route
 * offers none or the argument names nothing it offers. An advertised effort id
 * outranks the {@link DEFAULT_EFFORT_ARGUMENT} sentinel, so an adapter that
 * declares an effort literally named `default` stays reachable.
 * @param candidate - the route the effort argument applies to.
 * @param token - the exact argument text after the route.
 * @returns the effort the pick requests.
 * @throws when the route offers no efforts or the argument matches none.
 */
export function effortRequestFor(candidate: ModelCandidate, token: string): EffortRequest {
  const reasoning = candidate.reasoning
  if (reasoning === undefined) {
    throw new Error(`${candidate.provider}/${candidate.model} offers no reasoning efforts`)
  }
  const advertised = reasoning.efforts.find(effort => effort.id === token)
  if (advertised !== undefined) return { kind: 'effort', id: advertised.id }
  if (token === DEFAULT_EFFORT_ARGUMENT) return { kind: 'default' }
  throw new Error(
    `unknown effort "${displayLine(token)}" for ${displayLine(`${candidate.provider}/${candidate.model}`)}; available: ${DEFAULT_EFFORT_ARGUMENT}, ${reasoning.efforts.map(effort => displayLine(effort.id)).join(', ')}`,
  )
}

/** The image-carrying content a picked route must keep servable, read at pick time. */
export interface ImageAdmissionSurface {
  /** Messages queued for later steps, not yet on the model-visible surface. */
  readonly pending: readonly { readonly content: readonly ContentBlock[] }[]
  /** Messages on the current model-visible surface. */
  readonly logged: readonly { readonly content: readonly ContentBlock[] }[]
}

/** A surface admitting no images: the default when a caller names none. */
const NO_IMAGE_SURFACE: ImageAdmissionSurface = { pending: [], logged: [] }

/**
 * Reject a route the session's image content cannot ride, mirroring the web
 * host's `session.selectModel` guard: when queued or logged content carries an
 * image, the picked model must accept image input. A model that states no
 * input modalities is admitted, exactly as on the web surface.
 * @param llm - the adapter registry that resolves exact-model metadata.
 * @param resolved - the route {@link applyModelSelection} validated.
 * @param surface - the queued and logged content read at pick time.
 */
async function admitImages(
  llm: LlmRuntime,
  resolved: { provider: string; model: string },
  surface: ImageAdmissionSurface,
): Promise<void> {
  const carriesImage = [...surface.pending, ...surface.logged]
    .some(message => contentHasImage(message.content))
  if (!carriesImage) return
  const info = await llm.resolveModelInfo(resolved.provider, resolved.model)
  if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
    throw new Error(
      `model "${resolved.model}" does not accept image input, but this session already contains images; select an image-capable model`,
    )
  }
}

/**
 * The effort already in force on one route, when the selection is that route.
 * @param current - the selection reads resolve to right now.
 * @param candidate - the route being picked.
 * @returns the in-force effort on the same route, else `undefined`.
 */
function inForceEffort(
  current: ModelSelection | undefined,
  candidate: { provider: string; model: string },
): ReasoningEffortId | undefined {
  return current !== undefined && current.provider === candidate.provider && current.model === candidate.model
    ? current.reasoningEffort
    : undefined
}

/**
 * Validate one route the way a request would and install it as the selection
 * the next prompt assembly snapshots. A bare pick follows the web surface's
 * rule: re-picking the current route keeps its effort — pinned or absent —
 * while a new route takes its adapter's default, materialized exactly as the
 * web `/model` entry does. An explicit effort pins it, and a `default` request
 * installs no effort at all, so every request resolves the adapter's live
 * default and a persisted pick clears a stored effort. A route no adapter
 * serves — or one whose image input the session's image content needs and
 * lacks — rejects and leaves the previous selection in place.
 * @param llm - the adapter registry that validates the route.
 * @param selection - the mutable selection this terminal owns.
 * @param candidate - the route to install.
 * @param surface - the queued and logged content the route must keep servable.
 * @param effort - the explicit effort choice, when the reader made one.
 * @returns the selection subsequent requests carry.
 */
export async function applyModelSelection(
  llm: LlmRuntime,
  selection: ModelSelectionRef,
  candidate: ModelCandidate,
  surface: ImageAdmissionSurface = NO_IMAGE_SURFACE,
  effort?: EffortRequest,
): Promise<ModelSelection> {
  const current = selection.current
  const sameRoute = isSameRoute(current, candidate)
  const requested = effort !== undefined
    ? effort.kind === 'effort' ? effort.id : undefined
    : sameRoute ? current?.reasoningEffort : undefined
  const resolved = await llm.resolveCallConfig({
    provider: candidate.provider,
    model: candidate.model,
    ...requested === undefined ? {} : { reasoningEffort: requested },
  })
  await admitImages(llm, resolved, surface)
  const appliedEffort = effort !== undefined
    ? effort.kind === 'effort' ? resolved.reasoningEffort : undefined
    : sameRoute ? current?.reasoningEffort : resolved.reasoningEffort
  const applied: ModelSelection = {
    provider: resolved.provider,
    model: resolved.model,
    ...appliedEffort === undefined ? {} : { reasoningEffort: appliedEffort },
  }
  selection.current = applied
  return applied
}

/**
 * Whether the selection reads as exactly this route.
 * @param current - the selection reads resolve to right now.
 * @param candidate - the route being picked.
 * @returns whether the picked route is the selected one.
 */
function isSameRoute(
  current: ModelSelection | undefined,
  candidate: { provider: string; model: string },
): boolean {
  return current !== undefined && current.provider === candidate.provider && current.model === candidate.model
}

/** One selectable row of the picker's effort tier. */
export interface EffortRow {
  /** Sanitized one-row label naming the id the argument form accepts. */
  readonly label: string
  /** The effort this row picks. */
  readonly request: EffortRequest
}

/**
 * Build the effort tier's rows for one route: the model's default first, then
 * each adapter-declared effort in its order, mirroring the web composer's
 * effort pane.
 * @param reasoning - the route's adapter-declared efforts.
 * @returns the tier's rows.
 */
export function effortRows(reasoning: CandidateReasoning): readonly EffortRow[] {
  return [
    { label: `${DEFAULT_EFFORT_ARGUMENT} — the model's default effort`, request: { kind: 'default' } },
    ...reasoning.efforts.map(effort => ({
      label: `${displayLine(effort.id)} — ${displayLine(effort.name)}`,
      request: { kind: 'effort', id: effort.id } as EffortRequest,
    })),
  ]
}

/**
 * The effort the tier marks for one route: the selection's in-force effort on
 * the same route, else the adapter's default, mirroring the web composer's
 * marking.
 * @param candidate - the route the tier belongs to.
 * @param current - the selection reads resolve to right now.
 * @returns the effort a bare `enter` in the tier would apply.
 */
export function markedEffort(
  candidate: ModelCandidate,
  current: ModelSelection | undefined,
): ReasoningEffortId | undefined {
  const reasoning = candidate.reasoning
  if (reasoning === undefined) return undefined
  return inForceEffort(current, candidate) ?? reasoning.defaultEffort
}

/** One settled picker pick: the route and, when the effort tier made it, the effort choice. */
export interface ModelPick {
  /** The picked route. */
  readonly candidate: ModelCandidate
  /** The effort tier's choice; absent when the reader picked the route from the list. */
  readonly effort?: EffortRequest
}

/**
 * Settle the effort tier on one row.
 * @param tier - the drilled route and its rows.
 * @param index - the row the reader applied, always inside `rows`.
 * @returns the pick that row settles to.
 */
function settleTierRow(tier: { candidate: ModelCandidate; rows: readonly EffortRow[] }, index: number): ModelPick {
  return { candidate: tier.candidate, effort: (tier.rows[index] as EffortRow).request }
}

/** Everything the picker panel draws. */
export interface ModelPickerPanelOptions {
  /** The catalog read at open time. */
  readonly catalog: ModelCatalog
  /** The selection requests currently resolve to, marked in the list and tier; absent leaves nothing marked. */
  readonly current: ModelSelection | undefined
  /** The styles to draw with. */
  readonly palette: Palette
  /** Candidate rows the terminal has room for; at least one. */
  readonly visible: number
}

/**
 * The keyboard panel `/model` with no argument opens over the conversation:
 * one component with two states. The list state is the route roster — arrows
 * or a number move, `enter` applies, `→` drills into the effort tier when the
 * cursor route's adapter advertises efforts, `esc` dismisses. The tier state
 * is that route's efforts — `enter` applies the marked row, `esc` returns to
 * the list with its cursor intact. The tier is a state of this panel, not a
 * second panel, so dismissing it cannot tear down the list, and no key here
 * cancels the agent: a running turn and queued prompts survive every state.
 */
export class ModelPickerPanel implements Component {
  private readonly candidates: readonly ModelCandidate[]
  private readonly visible: number
  private cursor: number
  private settled = false
  private tier: { candidate: ModelCandidate; rows: readonly EffortRow[]; cursor: number } | undefined

  /**
   * @param options - the catalog, current selection, styles, and row budget.
   * @param onSettle - called exactly once with the pick, or `undefined` when dismissed.
   * @param onChange - called whenever the drawn content changes.
   */
  constructor(
    private readonly options: ModelPickerPanelOptions,
    private readonly onSettle: (pick: ModelPick | undefined) => void,
    private readonly onChange: () => void,
  ) {
    this.candidates = options.catalog.candidates
    this.visible = Math.min(options.visible, this.candidates.length)
    const current = options.current
    this.cursor = current === undefined ? 0 : Math.max(0, this.candidates.findIndex(
      candidate => candidate.provider === current.provider && candidate.model === current.model,
    ))
  }

  /** Nothing is cached between draws. */
  invalidate(): void {}

  /**
   * Draw the route list or the effort tier, its scroll overflow, provider
   * failures, and the controls that apply.
   * @param width - the panel width in columns.
   * @returns the panel's lines.
   */
  render(width: number): string[] {
    const tier = this.tier
    return tier === undefined ? this.renderList(width) : this.renderTier(tier, width)
  }

  /**
   * Draw the route list.
   * @param width - the panel width in columns.
   * @returns the list state's lines.
   */
  private renderList(width: number): string[] {
    const palette = this.options.palette
    const lines: string[] = [palette.bold('Model')]
    const first = Math.min(Math.max(0, this.cursor - this.visible + 1), this.candidates.length - this.visible)
    const shown = this.candidates.slice(first, first + this.visible)
    for (const [position, candidate] of shown.entries()) {
      const index = first + position
      const current = this.options.current
      const marked = current !== undefined
        && candidate.provider === current.provider
        && candidate.model === current.model
      const number = index < DIRECT_SELECT_LIMIT ? `${index + 1}.` : '  '
      const row = ` ${number} ${marked ? '●' : ' '} ${displayLine(`${candidate.provider}/${candidate.model}`)} — ${candidate.name}`
        .slice(0, width)
      lines.push(index === this.cursor ? palette.selected(row) : row)
    }
    const hidden = this.candidates.length - shown.length
    if (hidden > 0) lines.push(palette.dim(`… ${hidden} more`))
    for (const failure of this.options.catalog.failures) lines.push(palette.dim(`! ${failure}`))
    lines.push(palette.dim(this.listControls()))
    return lines
  }

  /**
   * Draw the effort tier.
   * @param tier - the drilled route, its rows, and its cursor.
   * @param width - the panel width in columns.
   * @returns the tier state's lines.
   */
  private renderTier(
    tier: { candidate: ModelCandidate; rows: readonly EffortRow[]; cursor: number },
    width: number,
  ): string[] {
    const palette = this.options.palette
    const visible = Math.min(this.options.visible, tier.rows.length)
    const lines: string[] = [
      palette.bold('Effort'),
      palette.dim(` ${displayLine(`${tier.candidate.provider}/${tier.candidate.model}`)}`),
    ]
    const first = Math.min(Math.max(0, tier.cursor - visible + 1), tier.rows.length - visible)
    const shown = tier.rows.slice(first, first + visible)
    const marked = markedEffort(tier.candidate, this.options.current)
    for (const [position, row] of shown.entries()) {
      const index = first + position
      const effective = marked !== undefined && row.request.kind === 'effort' && row.request.id === marked
      const number = index < DIRECT_SELECT_LIMIT ? `${index + 1}.` : '  '
      const text = ` ${number} ${effective ? '●' : ' '} ${row.label}`.slice(0, width)
      lines.push(index === tier.cursor ? palette.selected(text) : text)
    }
    const hidden = tier.rows.length - shown.length
    if (hidden > 0) lines.push(palette.dim(`… ${hidden} more`))
    lines.push(palette.dim(this.tierControls()))
    return lines
  }

  /**
   * Name the list's controls: movement disappears for a single route and the
   * drill appears only while the cursor route advertises efforts.
   * @returns the list state's controls hint.
   */
  private listControls(): string {
    const hints: string[] = []
    if (this.candidates.length > 1) hints.push('↑↓ move')
    if (this.candidates[this.cursor]?.reasoning !== undefined) hints.push('→ effort')
    hints.push('enter apply', 'esc cancel')
    return hints.join('  ')
  }

  /**
   * Name the tier's controls. The tier always offers the default beside at
   * least one declared effort, so movement always applies.
   * @returns the tier state's controls hint.
   */
  private tierControls(): string {
    return ['↑↓ move', 'enter apply', 'esc back'].join('  ')
  }

  /**
   * Route one key press to the drawn state: the list moves the cursor, a
   * number applies that row directly, `→` drills a route that advertises
   * efforts, `enter` applies the cursor row, and `esc` dismisses without
   * applying; the tier moves and applies the same way, and its `esc` returns
   * to the list. Nothing here cancels the agent, so a running turn and queued
   * prompts survive every tier state.
   * @param data - the raw input sequence.
   */
  handleInput(data: string): void {
    if (this.settled) return
    const tier = this.tier
    if (tier === undefined) this.listInput(data)
    else this.tierInput(tier, data)
  }

  /**
   * Handle one key press in the list state.
   * @param data - the raw input sequence.
   */
  private listInput(data: string): void {
    if (this.candidates.length > 1 && matchesKey(data, 'up')) {
      this.cursor = (this.cursor + this.candidates.length - 1) % this.candidates.length
      this.onChange()
      return
    }
    if (this.candidates.length > 1 && matchesKey(data, 'down')) {
      this.cursor = (this.cursor + 1) % this.candidates.length
      this.onChange()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.finish({ candidate: this.candidates[this.cursor] as ModelCandidate })
      return
    }
    if (matchesKey(data, 'escape')) {
      this.finish(undefined)
      return
    }
    if (matchesKey(data, 'right')) {
      this.drill(this.candidates[this.cursor])
      return
    }
    const digit = Number.parseInt(data, 10)
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(this.candidates.length, DIRECT_SELECT_LIMIT)) {
      this.finish({ candidate: this.candidates[digit - 1] as ModelCandidate })
    }  }

  /**
   * Handle one key press in the tier state.
   * @param tier - the drilled route, its rows, and its cursor.
   * @param data - the raw input sequence.
   */
  private tierInput(tier: { candidate: ModelCandidate; rows: readonly EffortRow[]; cursor: number }, data: string): void {
    if (tier.rows.length > 1 && matchesKey(data, 'up')) {
      tier.cursor = (tier.cursor + tier.rows.length - 1) % tier.rows.length
      this.onChange()
      return
    }
    if (tier.rows.length > 1 && matchesKey(data, 'down')) {
      tier.cursor = (tier.cursor + 1) % tier.rows.length
      this.onChange()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.finish(settleTierRow(tier, tier.cursor))
      return
    }
    if (matchesKey(data, 'escape')) {
      this.tier = undefined
      this.onChange()
      return
    }
    const digit = Number.parseInt(data, 10)
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(tier.rows.length, DIRECT_SELECT_LIMIT)) {
      this.finish(settleTierRow(tier, digit - 1))
    }
  }

  /**
   * Open the effort tier for a route that advertises efforts; a route without
   * any stays on the list, because an empty tier is not an effort choice.
   * @param candidate - the route under the list cursor.
   */
  private drill(candidate: ModelCandidate | undefined): void {
    if (candidate?.reasoning === undefined) return
    const rows = effortRows(candidate.reasoning)
    const marked = markedEffort(candidate, this.options.current)
    const cursor = Math.max(0, rows.findIndex(row => row.request.kind === 'effort' && row.request.id === marked))
    this.tier = { candidate, rows, cursor }
    this.onChange()
  }

  /**
   * Settle the panel exactly once.
   * @param pick - the picked route and effort, or `undefined` when dismissed.
   */
  private finish(pick: ModelPick | undefined): void {
    this.settled = true
    this.onSettle(pick)
  }
}

/** Everything the `/model` command reads and writes. */
export interface ModelSelectionUi {
  /** The adapter registry this composition mounts; absent fails the command loud. */
  readonly llm: LlmRuntime | undefined
  /** The mutable selection this terminal installed on its agent. */
  readonly selection: ModelSelectionRef
  /** The surface the picker panel appears on. */
  readonly host: PanelHost
  /** The styles the panel draws with. */
  readonly palette: Palette
  /** Current terminal rows, for the picker's row gate. */
  readonly rows: () => number
  /** Candidate rows the composition configured, before terminal-height degradation. */
  readonly maxVisible: number
  /**
   * Read the image-carrying content a pick must keep servable, at pick time;
   * absent admits every validated route, for callers driving no session.
   */
  readonly imageSurface?: (() => ImageAdmissionSurface) | undefined
  /**
   * Persist a pick as the deployment default, following the web surface;
   * a rejection rides {@link CommandResult} as a warning, not a failed pick.
   * Absent when the composition mounts no default-model service.
   */
  readonly persist?: ((selection: ModelSelection) => Promise<void>) | undefined
  /** Called after a route was installed, to refresh what names it. */
  readonly onApplied: (provider: string, model: string) => void
}

/** One installed pick plus what its default-persistence did. */
interface AppliedPick {
  /** The selection subsequent requests carry. */
  readonly applied: ModelSelection
  /** The effort that will reach the next request: the applied effort, else the route's declared default. */
  readonly inForce: ReasoningEffortId | undefined
  /** The selection the pick replaced, for the switch notice's effort transition. */
  readonly previous: ModelSelection | undefined
  /** Why the pick did not persist as the deployment default, when the save rejected. */
  readonly saveWarning: string | undefined
}

/**
 * Validate, admit, and install one picked route, then persist it as the
 * deployment default. The pick itself is settled the moment the selection is
 * installed, so a rejected default-save degrades to a warning rather than
 * failing the switch.
 * @param ui - the registries and persistence this pick reads.
 * @param llm - the adapter registry that validates the route.
 * @param candidate - the picked route.
 * @param effort - the explicit effort choice, when the reader made one.
 * @returns the installed selection and any persistence warning.
 */
async function installPick(
  ui: ModelSelectionUi,
  llm: LlmRuntime,
  candidate: ModelCandidate,
  effort?: EffortRequest,
): Promise<AppliedPick> {
  const previous = ui.selection.current
  const applied = await applyModelSelection(llm, ui.selection, candidate, ui.imageSurface?.() ?? NO_IMAGE_SURFACE, effort)
  ui.onApplied(applied.provider, applied.model)
  let saveWarning: string | undefined
  try {
    await ui.persist?.(applied)
  } catch (error: unknown) {
    saveWarning = `not saved as the default: ${errorText(error)}`
  }
  return { applied, inForce: applied.reasoningEffort ?? candidate.reasoning?.defaultEffort, previous, saveWarning }
}

/** The most arguments `/model` accepts: a route and an effort. */
const MAX_ARGUMENTS = 2

/**
 * Run one `/model` invocation. Arguments select directly — scripted use and
 * muscle memory — and fail loud naming what was asked for and what the
 * catalog offers: `/model <route>` switches on the route's default effort,
 * and `/model <route> <effort>` pins an advertised effort or `default`; no
 * argument opens the keyboard panel, bounded by the same row gate the
 * input-trigger menus degrade through, and the command settles with the
 * reader: a picked route switches, a dismissed picker changes nothing.
 * @param ui - the registries and surfaces this command reads.
 * @param rawInput - the exact text after the command name.
 * @returns the command outcome, rendered by the dispatching UI.
 */
export async function runModelCommand(ui: ModelSelectionUi, rawInput: string): Promise<CommandResult> {
  const llm = ui.llm
  if (llm === undefined) {
    return { kind: 'error', text: 'no model directory is available: this composition mounts no llm service' }
  }
  const catalog = await modelCandidates(llm)
  const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) return await pickerResult(ui, llm, catalog)
  if (tokens.length > MAX_ARGUMENTS) {
    return { kind: 'error', text: `usage: /model <provider/model> [${DEFAULT_EFFORT_ARGUMENT} | <effort>]` }
  }
  const match = findCandidate(catalog.candidates, tokens[0] as string)
  if (match === undefined) {
    return { kind: 'error', text: `unknown model "${displayLine(tokens[0] as string)}"; ${availableText(catalog)}` }
  }
  if (match.kind === 'ambiguous') {
    return {
      kind: 'error',
      text: `model "${displayLine(match.model)}" is served by providers ${match.providers.map(displayLine).join(', ')}; name it as provider/model`,
    }
  }
  const candidate = match.candidate
  let effort: EffortRequest | undefined
  if (tokens.length === MAX_ARGUMENTS) {
    try {
      effort = effortRequestFor(candidate, tokens[MAX_ARGUMENTS - 1] as string)
    } catch (error: unknown) {
      return { kind: 'error', text: errorText(error) }
    }
  }
  let pick: AppliedPick
  try {
    pick = await installPick(ui, llm, candidate, effort)
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: `cannot switch to ${displayLine(tokens[0] as string)}: ${errorText(error)}`,
    }
  }
  return { kind: 'success', text: switchText(pick) }
}

/**
 * Open the picker when the terminal has room for one candidate row and the
 * catalog has a route to offer; otherwise fail loud with what to do instead.
 * @param ui - the surfaces and bounds the picker reads.
 * @param llm - the adapter registry that validates a picked route.
 * @param catalog - the catalog read at open time.
 * @returns the outcome once the reader picked or dismissed.
 */
function pickerResult(ui: ModelSelectionUi, llm: LlmRuntime, catalog: ModelCatalog): Promise<CommandResult> {
  const visible = menuRowsFor(ui.rows(), ui.maxVisible)
  if (visible <= 0) {
    return Promise.resolve({
      kind: 'error',
      text: 'the terminal is too small for the model picker; switch with /model <provider>/<model>',
    })
  }
  if (catalog.candidates.length === 0) {
    return Promise.resolve({ kind: 'error', text: `no models are available; ${availableText(catalog)}` })
  }
  return new Promise<CommandResult>((resolve) => {
    const panel = new ModelPickerPanel(
      { catalog, current: ui.selection.current, palette: ui.palette, visible },
      (pick) => {
        close()
        if (pick === undefined) {
          resolve({ kind: 'success' })
          return
        }
        void installPick(ui, llm, pick.candidate, pick.effort).then(
          (applied) => {
            resolve({ kind: 'success', text: switchText(applied) })
          },
          (error: unknown) => {
            resolve({
              kind: 'error',
              text: `cannot switch to ${displayLine(`${pick.candidate.provider}/${pick.candidate.model}`)}: ${errorText(error)}`,
            })
          },
        )
      },
      () => { ui.host.requestRender() },
    )
    const close = ui.host.present(panel)
  })
}

/**
 * Name one installed route for the reader, the effort that will reach the next
 * request, and any default-save warning. A replaced in-force effort is named —
 * `was <effort>` — however that effort arose: the stored section cannot
 * distinguish an explicit pick from a materialized default, so the notice
 * states the transition instead of guessing a provenance.
 * @param pick - the installed pick and what it replaced.
 * @returns the switched-to line.
 */
function switchText(pick: AppliedPick): string {
  const route = displayLine(`${pick.applied.provider}/${pick.applied.model}`)
  const was = pick.previous?.reasoningEffort
  const effort = pick.inForce === undefined
    ? was === undefined ? '' : ` (no reasoning effort; was ${displayLine(was)})`
    : was !== undefined && was !== pick.inForce
      ? ` (reasoning ${displayLine(pick.inForce)}, was ${displayLine(was)})`
      : ` (reasoning ${displayLine(pick.inForce)})`
  const warning = pick.saveWarning === undefined ? '' : `; ${pick.saveWarning}`
  return `Model switched to ${route}${effort}${warning}`
}

/**
 * Name what the catalog offers, for a reader whose argument matched nothing.
 * @param catalog - the catalog read at match time.
 * @returns the offered-routes clause.
 */
function availableText(catalog: ModelCatalog): string {
  const offered = catalog.candidates.map(candidate => `${candidate.provider}/${candidate.model}`).join(', ')
  const failures = catalog.failures.length === 0 ? '' : `; failed to list ${catalog.failures.join('; ')}`
  return `available: ${offered === '' ? 'nothing' : offered}${failures}`
}
