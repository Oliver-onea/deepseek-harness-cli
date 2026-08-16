/**
 * The input-trigger menus: `/` offers the commands the live registry resolves
 * for this agent, `@` offers workspace files. Candidate sourcing, suggestion
 * state, and keyboard arbitration belong to pi-tui's autocomplete; this module
 * feeds it live data, normalizes untrusted text, and bounds the menu to the
 * terminal's rows.
 * @module @deepseek-ai/dsh-tui/autocomplete
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import { StartupRefusalError } from '@deepseek-ai/dsh-app-boot/errors'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { displayLine } from './display-text.ts'

/** Everything the input-trigger menus read. */
export interface AutocompleteOptions {
  /** Live command descriptors for the `/` menu, read on every query. */
  commands: () => readonly CommandDescriptor[]
  /** Directory the `@` menu searches. */
  workspacePath: string
  /** File-finder binary backing fuzzy `@` search; `null` disables that search. */
  fileFinderPath: string | null
  /** Menu rows before scrolling, before terminal-height degradation. */
  maxVisible: number
}

/** The menu data plus the bounds wiring only the shell supplies. */
interface BoundedAutocompleteOptions extends AutocompleteOptions {
  /** Current terminal rows, for degradation. */
  rows: () => number
  /**
   * Apply the degraded row bound before the editor builds its suggestion
   * list; called synchronously at the start of every query.
   */
  syncMaxVisible: (visible: number) => void
}

/**
 * Rows the layout owes to the conversation whatever the menus do: one
 * transcript row, the editor's three (border, input, border), and the footer.
 */
export const RESERVED_ROWS = 5

/**
 * Bound the menu so the footer, the editor, and one transcript row survive a
 * small terminal: the menu yields before anything else does. A terminal with
 * no room for a candidate row beyond the reserved rows gets no menu.
 * @param rows - current terminal rows.
 * @param configured - menu rows the composition configured.
 * @returns candidate rows a menu may draw, zero for none.
 */
export function menuRowsFor(rows: number, configured: number): number {
  // One row of the budget goes to the list's scroll indicator whenever the
  // candidates overflow the visible rows.
  return Math.min(configured, Math.max(0, rows - RESERVED_ROWS - 1))
}

/**
 * Map live command descriptors to pi-tui's slash-command candidates, with the
 * untrusted registry text normalized for display. The name needs no
 * normalization: the registry admits only `[a-z][a-z0-9_-]*`.
 * @param commands - descriptors the registry resolves for this agent.
 * @returns the candidates for the `/` menu.
 */
export function commandItems(commands: readonly CommandDescriptor[]): SlashCommand[] {
  return commands.map(command => ({
    name: command.name,
    description: displayLine(command.description),
    ...command.input === undefined ? {} : { argumentHint: displayLine(command.input.hint) },
  }))
}

/**
 * Normalize one candidate's rendered text. The value stays literal so
 * completion inserts exactly what was found; labels and descriptions come
 * from registries and the filesystem, so they pass through `displayLine`.
 * @param item - the candidate pi-tui produced.
 * @returns the candidate the editor may draw.
 */
export function displayItem(item: AutocompleteItem): AutocompleteItem {
  return {
    value: item.value,
    label: displayLine(item.label),
    ...item.description === undefined ? {} : { description: displayLine(item.description) },
  }
}

/**
 * The terminal's input-trigger menus over pi-tui's combined provider. The
 * command roster is read per query, so a command registered after this
 * provider was installed appears in the next `/` query without a restart.
 */
export class TerminalAutocomplete implements AutocompleteProvider {
  /** The `@` file trigger; `/` is built into the editor itself. */
  readonly triggerCharacters = ['@']

  /**
   * The completion editor for picks and forced-trigger rules. It carries no
   * command roster: `applyCompletion` and `shouldTriggerFileCompletion` read
   * only the buffer, so one instance serves every query.
   */
  private readonly delegate: CombinedAutocompleteProvider

  /**
   * @param options - the live data and bounds wiring the menus read.
   */
  constructor(private readonly options: BoundedAutocompleteOptions) {
    this.delegate = new CombinedAutocompleteProvider([], options.workspacePath, options.fileFinderPath)
  }

  /**
   * Serve one query: bound the menu to the terminal's rows, read the command
   * roster live, and normalize whatever the provider found.
   * @param lines - the editor's lines at query time.
   * @param cursorLine - the cursor's line index.
   * @param cursorCol - the cursor's column.
   * @param options - the abort signal and force flag of this query.
   * @returns the normalized suggestions, or `null` when nothing offers.
   */
  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const visible = menuRowsFor(this.options.rows(), this.options.maxVisible)
    this.options.syncMaxVisible(visible)
    if (visible <= 0) return null
    const provider = new CombinedAutocompleteProvider(
      commandItems(this.options.commands()),
      this.options.workspacePath,
      this.options.fileFinderPath,
    )
    const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, options)
    if (suggestions === null) return null
    return { items: suggestions.items.map(displayItem), prefix: suggestions.prefix }
  }

  /**
   * Apply a picked candidate in the editor buffer, exactly as the delegate
   * computes it.
   * @param lines - the editor's lines at pick time.
   * @param cursorLine - the cursor's line index.
   * @param cursorCol - the cursor's column.
   * @param item - the picked candidate.
   * @param prefix - the trigger text the candidate replaces.
   * @returns the buffer and cursor after the pick.
   */
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  /**
   * Whether a forced completion may run here; the delegate owns the rule.
   * @param lines - the editor's lines.
   * @param cursorLine - the cursor's line index.
   * @param cursorCol - the cursor's column.
   * @returns whether file completion should trigger.
   */
  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.delegate.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
  }
}

/** File-finder binary names in PATH-preference order. */
/* v8 ignore next -- the win32 arm is unreachable on a non-Windows host */
const FINDER_NAMES = process.platform === 'win32' ? ['fd.exe'] : ['fd', 'fdfind']

/**
 * Whether one candidate path is an executable regular file.
 * @param candidate - the path to test.
 * @returns whether it can run as the file finder.
 */
function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the file-finder binary behind fuzzy `@` search.
 * @param explicit - the composition's `fileFinderPath`, when it states one.
 * @returns the binary to spawn, or `null` when no finder is available.
 * @throws {@link StartupRefusalError} when an explicit path does not exist.
 */
export function resolveFileFinder(explicit: string | undefined): string | null {
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new StartupRefusalError(
        `dsh-tui: fileFinderPath ${JSON.stringify(explicit)} does not exist; fix the path or remove the key to search PATH`,
      )
    }
    return explicit
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const name of FINDER_NAMES) {
      const candidate = join(directory, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}
