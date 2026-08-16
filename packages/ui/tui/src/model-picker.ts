/**
 * The `/model` command: read the live model catalog through the `llm` service
 * — the same registry the web host serves as `session.models` — and switch the
 * route this terminal's `ModelSelectionRef` hands to prompt assembly, then
 * persist the pick as the deployment default the way the web surface does.
 * With no argument it opens a keyboard panel; with an argument it selects
 * directly.
 * @module @deepseek-ai/dsh-tui/model-picker
 */

import { matchesKey, type Component } from '@earendil-works/pi-tui'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { contentHasImage, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { menuRowsFor } from './autocomplete.ts'
import { displayLine } from './display-text.ts'
import { DIRECT_SELECT_LIMIT, type PanelHost } from './questions.ts'
import type { Palette } from './theme.ts'

/** One selectable route the catalog advertised. */
export interface ModelCandidate {
  /** Registered provider route id, used to route requests. */
  readonly provider: string
  /** Provider-owned model id, used to route requests. */
  readonly model: string
  /** Provider-supplied display name, sanitized for one terminal row. */
  readonly name: string
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
 * host serves as `session.models`: each provider lists independently, a
 * failing provider rides {@link ModelCatalog.failures} without failing the
 * sound ones, and a provider advertising nothing contributes nothing.
 * @param llm - the adapter registry this composition mounts.
 * @returns the catalog the picker draws and direct selection matches against.
 */
export async function modelCandidates(llm: LlmRuntime): Promise<ModelCatalog> {
  const candidates: ModelCandidate[] = []
  const failures: string[] = []
  for (const provider of llm.listProviders()) {
    try {
      for (const info of await llm.listModels(provider.id)) {
        candidates.push({ provider: provider.id, model: info.id, name: displayLine(info.name) })
      }
    } catch (error: unknown) {
      failures.push(displayLine(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  return { candidates, failures }
}

/** What matching one `/model` argument against the catalog found. */
export type CandidateMatch =
  | { kind: 'candidate'; candidate: ModelCandidate }
  | { kind: 'ambiguous'; model: string; providers: string[] }

/**
 * Match one `/model` argument against the catalog: `provider/model` names one
 * route, a bare model id must be unique across providers.
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
 * Validate one route the way a request would and install it as the selection
 * the next prompt assembly snapshots. The adapter materializes the model's
 * default reasoning effort here, exactly as the web `/model` entry does; a
 * route no adapter serves — or one whose image input the session's image
 * content needs and lacks — rejects and leaves the previous selection in place.
 * @param llm - the adapter registry that validates the route.
 * @param selection - the mutable selection this terminal owns.
 * @param candidate - the route to install.
 * @param surface - the queued and logged content the route must keep servable.
 * @returns the selection subsequent requests carry.
 */
export async function applyModelSelection(
  llm: LlmRuntime,
  selection: ModelSelectionRef,
  candidate: ModelCandidate,
  surface: ImageAdmissionSurface = NO_IMAGE_SURFACE,
): Promise<ModelSelection> {
  const resolved = await llm.resolveCallConfig({ provider: candidate.provider, model: candidate.model })
  await admitImages(llm, resolved, surface)
  const applied: ModelSelection = {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
  }
  selection.current = applied
  return applied
}

/** Everything the picker panel draws. */
export interface ModelPickerPanelOptions {
  /** The catalog read at open time. */
  readonly catalog: ModelCatalog
  /** The route requests currently use, marked in the list; absent leaves nothing marked. */
  readonly current: { provider: string; model: string } | undefined
  /** The styles to draw with. */
  readonly palette: Palette
  /** Candidate rows the terminal has room for; at least one. */
  readonly visible: number
}

/** The keyboard panel `/model` with no argument opens over the conversation. */
export class ModelPickerPanel implements Component {
  private readonly candidates: readonly ModelCandidate[]
  private readonly visible: number
  private cursor: number
  private settled = false

  /**
   * @param options - the catalog, current route, styles, and row budget.
   * @param onSettle - called exactly once with the picked route, or `undefined` when dismissed.
   * @param onChange - called whenever the drawn content changes.
   */
  constructor(
    private readonly options: ModelPickerPanelOptions,
    private readonly onSettle: (candidate: ModelCandidate | undefined) => void,
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
   * Draw the route list, its scroll overflow, provider failures, and the
   * controls that apply.
   * @param width - the panel width in columns.
   * @returns the panel's lines.
   */
  render(width: number): string[] {
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
    lines.push(palette.dim(this.controls()))
    return lines
  }

  /**
   * Name the controls that currently do something.
   * @returns the controls hint.
   */
  private controls(): string {
    const hints = this.candidates.length > 1 ? ['↑↓ move'] : []
    hints.push('enter apply', 'esc cancel')
    return hints.join('  ')
  }

  /**
   * Route one key press: arrows move the cursor, a number applies that row
   * directly, `enter` applies the cursor row, `esc` dismisses without
   * applying. Nothing here cancels the agent, so a running turn and queued
   * prompts survive a dismissed picker.
   * @param data - the raw input sequence.
   */
  handleInput(data: string): void {
    if (this.settled) return
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
      this.finish(this.candidates[this.cursor])
      return
    }
    if (matchesKey(data, 'escape')) {
      this.finish(undefined)
      return
    }
    const digit = Number.parseInt(data, 10)
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(this.candidates.length, DIRECT_SELECT_LIMIT)) {
      this.finish(this.candidates[digit - 1])
    }
  }

  /**
   * Settle the panel exactly once.
   * @param candidate - the picked route, or `undefined` when dismissed.
   */
  private finish(candidate: ModelCandidate | undefined): void {
    this.settled = true
    this.onSettle(candidate)
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
 * @returns the installed selection and any persistence warning.
 */
async function installPick(ui: ModelSelectionUi, llm: LlmRuntime, candidate: ModelCandidate): Promise<AppliedPick> {
  const applied = await applyModelSelection(llm, ui.selection, candidate, ui.imageSurface?.() ?? NO_IMAGE_SURFACE)
  ui.onApplied(applied.provider, applied.model)
  let saveWarning: string | undefined
  try {
    await ui.persist?.(applied)
  } catch (error: unknown) {
    saveWarning = `not saved as the default: ${error instanceof Error ? error.message : String(error)}`
  }
  return { applied, saveWarning }
}

/**
 * Run one `/model` invocation. An argument selects directly — scripted use and
 * muscle memory — and fails loud naming what was asked for and what the
 * catalog offers; no argument opens the keyboard panel, bounded by the same
 * row gate the input-trigger menus degrade through, and the command settles
 * with the reader: a picked route switches, a dismissed picker changes
 * nothing.
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
  const query = rawInput.trim()
  if (query === '') return await pickerResult(ui, llm, catalog)
  const match = findCandidate(catalog.candidates, query)
  if (match === undefined) {
    return { kind: 'error', text: `unknown model "${displayLine(query)}"; ${availableText(catalog)}` }
  }
  if (match.kind === 'ambiguous') {
    return {
      kind: 'error',
      text: `model "${displayLine(match.model)}" is served by providers ${match.providers.map(displayLine).join(', ')}; name it as provider/model`,
    }
  }
  let pick: AppliedPick
  try {
    pick = await installPick(ui, llm, match.candidate)
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: `cannot switch to ${displayLine(query)}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { kind: 'success', text: switchText(pick.applied, pick.saveWarning) }
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
      (candidate) => {
        close()
        if (candidate === undefined) {
          resolve({ kind: 'success' })
          return
        }
        void installPick(ui, llm, candidate).then(
          (pick) => {
            resolve({ kind: 'success', text: switchText(pick.applied, pick.saveWarning) })
          },
          (error: unknown) => {
            resolve({
              kind: 'error',
              text: `cannot switch to ${displayLine(`${candidate.provider}/${candidate.model}`)}: ${error instanceof Error ? error.message : String(error)}`,
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
 * Name one installed route for the reader, and any default-save warning.
 * @param selection - the selection subsequent requests carry.
 * @param saveWarning - why the pick did not persist as the default, when it did not.
 * @returns the switched-to line.
 */
function switchText(selection: ModelSelection, saveWarning: string | undefined): string {
  const route = displayLine(`${selection.provider}/${selection.model}`)
  const effort = selection.reasoningEffort === undefined
    ? ''
    : ` (reasoning ${displayLine(selection.reasoningEffort)})`
  const warning = saveWarning === undefined ? '' : `; ${saveWarning}`
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
