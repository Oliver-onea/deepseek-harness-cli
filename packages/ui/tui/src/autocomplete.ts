/**
 * The input-trigger menus: `/` offers the commands the live registry resolves
 * for this agent, `@` offers its running subagent children. Candidate
 * sourcing reads live rosters per query; suggestion state, debouncing,
 * keyboard arbitration, and rendering belong to pi-tui's editor, and this
 * provider bounds the menu to the terminal's rows.
 * @module @deepseek-ai/dsh-tui/autocomplete
 */

import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { displayLine } from './display-text.ts'

/** One running subagent child the `@` menu may offer. */
export interface RunningChild {
  /** Display name: sanitized before it reaches the editor. */
  readonly name: string
}

/** Everything the input-trigger menus read. */
export interface AutocompleteOptions {
  /** Live command descriptors for the `/` menu, read on every query. */
  commands: () => readonly CommandDescriptor[]
  /**
   * Running subagent children of the driven session, when the composition
   * mounts the subagent capability; `undefined` leaves `@` offering nothing.
   */
  subagents?: ((signal: AbortSignal) => Promise<readonly RunningChild[]>) | undefined
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
 * no room for a candidate row beyond the reserved rows gets no menu — the
 * trigger key stays inert, because no suggestion list exists to capture keys.
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
export function commandItems(commands: readonly CommandDescriptor[]): AutocompleteItem[] {
  return commands.map((command) => {
    const hint = command.input === undefined ? undefined : displayLine(command.input.hint)
    const description = displayLine(command.description)
    // A present hint is non-empty: the registry rejects empty hints.
    return {
      value: command.name,
      label: command.name,
      description: hint === undefined ? description : `${hint} — ${description}`,
    }
  })
}

/**
 * The display name of one subagent child: the durable session title when the
 * child has a live agent, else the creation label, else the raw id — matching
 * the web session list's title-first ladder.
 * @param entry - the listed child.
 * @param agent - the child's live agent, when one is registered.
 * @returns the unsanitized display name.
 */
export function childDisplayName(entry: SubagentListEntry & { readonly kind: 'child' }, agent: Agent | undefined): string {
  const title = agent === undefined ? undefined : foldSessionTitle(agent.session.events)?.title
  return title ?? entry.label ?? entry.id
}

/**
 * Whether one listed child is running: its live agent's status when one is
 * registered, else the session store's liveness — the only signal an
 * out-of-process child has. Non-child entries (diagnostics) never run.
 * @param entry - the listed child.
 * @param agent - the child's live agent, when one is registered.
 * @returns whether the `@` menu may offer this entry.
 */
export function childRunning(
  entry: SubagentListEntry,
  agent: Agent | undefined,
): entry is SubagentListEntry & { readonly kind: 'child' } {
  if (entry.kind !== 'child') return false
  return agent !== undefined ? agent.status === 'running' : entry.activity === 'running'
}

/**
 * The `@` token under the cursor, when the text before it ends in one: the
 * `@` plus the query typed so far, matching the editor's word-boundary
 * trigger. A query cannot contain a space — space ends the token — so names
 * with spaces match on their first word while typing.
 * @param beforeCursor - the current line's text before the cursor.
 * @returns the `@token`, or `null` when the cursor does not close one.
 */
export function atTokenOf(beforeCursor: string): string | null {
  /* v8 ignore next -- splitting always yields at least one word; the ?? satisfies pop's optional typing */
  const token = beforeCursor.split(/\s/u).pop() ?? ''
  return token.startsWith('@') ? token : null
}

/**
 * The terminal's input-trigger menus over pi-tui's editor: a flat candidate
 * list per trigger, live-roster sourced, with untrusted text normalized
 * before the editor can draw it. The command roster is read per query, so a
 * command registered after this provider was installed appears in the next
 * `/` query without a restart.
 */
export class TerminalAutocomplete implements AutocompleteProvider {
  /** The `@` subagent trigger; `/` is built into the editor itself. */
  readonly triggerCharacters = ['@']

  /**
   * @param options - the live data and bounds wiring the menus read.
   */
  constructor(private readonly options: BoundedAutocompleteOptions) {}

  /**
   * Serve one query: bound the menu to the terminal's rows, then answer the
   * trigger under the cursor — `@` from the running-children roster, `/` at
   * the start of the input from the live command registry.
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
    /* v8 ignore next -- the editor passes the cursor's own line, which exists; the ?? satisfies indexing typing */
    const beforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol)
    const atToken = atTokenOf(beforeCursor)
    if (atToken !== null) return this.subagentSuggestions(atToken, options.signal)
    if (cursorLine === 0 && beforeCursor.trimStart().startsWith('/') && !beforeCursor.includes(' ')) {
      const items = fuzzyFilter(commandItems(this.options.commands()), beforeCursor.trimStart().slice(1), item => item.value)
      return items.length === 0 ? null : { items, prefix: beforeCursor.trimStart() }
    }
    // No trigger under the cursor, a `/` on a later line, or a command line
    // already past its name: nothing offers.
    return null
  }

  /**
   * Answer one `@` query from the running-children roster. A roster the
   * composition did not mount, one that fails, or one with no running child
   * offers nothing — absence, not a substitute feature.
   * @param atToken - the `@token` under the cursor.
   * @param signal - the query's abort signal, forwarded to the roster read.
   * @returns the matching candidates, or `null`.
   */
  private async subagentSuggestions(atToken: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
    const roster = this.options.subagents
    if (roster === undefined) return null
    let children: readonly RunningChild[]
    try {
      children = await roster(signal)
    } catch {
      // A roster read that fails offers no menu; the subagent capability's
      // own operations fail loud through their callers.
      return null
    }
    if (signal.aborted) return null
    const query = atToken.slice(1)
    const items = children
      .filter(child => child.name.includes(query))
      .map((child): AutocompleteItem => {
        const name = displayLine(child.name)
        return { value: name, label: name }
      })
    return items.length === 0 ? null : { items, prefix: atToken }
  }

  /**
   * Apply a picked candidate in the editor buffer. A `/` pick completes to
   * the command line; an `@` pick inserts the reference `@name ` — the same
   * literal the web draft carries, trailing space closing the token — which
   * then ships to the model verbatim as ordinary prompt text.
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
    /* v8 ignore next -- the editor passes the cursor's own line, which exists; the ?? satisfies indexing typing */
    const currentLine = lines[cursorLine] ?? ''
    const before = currentLine.slice(0, cursorCol - prefix.length)
    const after = currentLine.slice(cursorCol)
    const completion = prefix.startsWith('@') ? `@${item.value} ` : `/${item.value} `
    const nextLine = `${before}${completion}${after}`
    const next = [...lines]
    next[cursorLine] = nextLine
    return { lines: next, cursorLine, cursorCol: before.length + completion.length }
  }

  /**
   * Whether a forced completion may run here. File completion is not a
   * terminal capability: the trigger key and `tab` never open a file menu.
   * @returns always `false`.
   */
  shouldTriggerFileCompletion(): boolean {
    return false
  }
}
