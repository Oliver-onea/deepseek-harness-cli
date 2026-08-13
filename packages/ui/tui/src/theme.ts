/**
 * The TUI palette: standard 16-color ANSI foregrounds and SGR attributes only.
 * Body text and backgrounds stay at the terminal's own defaults, so a host
 * terminal's light or dark theme remaps the whole interface and this package
 * ships no theme setting of its own.
 * @module @deepseek-ai/dsh-tui/theme
 */

/** One styling function; identity when the palette is colorless. */
export type Style = (text: string) => string

/** The styles the renderer addresses by role rather than by color name. */
export interface Palette {
  /** Secondary text: timing, hints, folded-line counts, reasoning. */
  dim: Style
  /** Emphasis inside otherwise plain text. */
  bold: Style
  /** The human's own turns. */
  user: Style
  /** Tool-call headers and other structural labels. */
  tool: Style
  /** Successful or affirmative status. */
  success: Style
  /** Warnings and interrupted work. */
  warn: Style
  /** Failures. */
  error: Style
  /** Removed lines in a diff. */
  removed: Style
  /** Added lines in a diff. */
  added: Style
  /** Fenced-code bodies. */
  code: Style
  /** The current row of a keyboard selector. */
  selected: Style
}

/**
 * Wrap text in one SGR pair.
 * @param open - the SGR parameters that start the run.
 * @param close - the SGR parameters that end it.
 * @returns a style applying that pair.
 */
function sgr(open: string, close: string): Style {
  return text => `\x1b[${open}m${text}\x1b[${close}m`
}

/** The colorless palette every role shares when `color` is off. */
const PLAIN: Style = text => text

/**
 * Build the palette for one TUI instance.
 * @param color - whether to emit SGR sequences at all.
 * @returns the role-keyed styles the renderer uses.
 */
export function createPalette(color: boolean): Palette {
  if (!color) {
    return {
      dim: PLAIN, bold: PLAIN, user: PLAIN, tool: PLAIN, success: PLAIN,
      warn: PLAIN, error: PLAIN, removed: PLAIN, added: PLAIN, code: PLAIN,
      selected: PLAIN,
    }
  }
  return {
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    user: sgr('36', '39'),
    tool: sgr('34', '39'),
    success: sgr('32', '39'),
    warn: sgr('33', '39'),
    error: sgr('31', '39'),
    removed: sgr('31', '39'),
    added: sgr('32', '39'),
    code: sgr('35', '39'),
    // Reverse video rather than a background color: it inverts whatever the
    // host terminal already uses, so selection stays legible in both themes.
    selected: sgr('7', '27'),
  }
}
