/**
 * Terminal-safe text normalization. Everything the TUI prints — model output,
 * session data, tool presentation, question text, diagnostics, and the pane
 * title — passes through {@link displayText} first, so only this package and
 * pi-tui ever emit ANSI control sequences.
 * @module @deepseek-ai/dsh-tui/display-text
 */

/** Columns one horizontal tab advances to; matches the default terminal tab stop. */
const TAB_WIDTH = 8

/**
 * Control characters that survive normalization instead of becoming a visible
 * escape: the line feed is the layout unit every renderer here splits on.
 */
const LINE_FEED = 0x0a

/**
 * Render one control code point as its visible `\xNN` escape.
 * @param code - the code point to escape.
 * @returns the two-digit hexadecimal escape text.
 */
function escapeControl(code: number): string {
  return `\\x${code.toString(16).padStart(2, '0')}`
}

/**
 * Expand one tab to the next tab stop, measured from the current column.
 * @param column - columns already emitted on the current line.
 * @returns the spaces that advance to the next stop.
 */
function expandTab(column: number): string {
  return ' '.repeat(TAB_WIDTH - (column % TAB_WIDTH))
}

/**
 * Normalize arbitrary text for terminal display: CRLF and lone CR collapse to
 * line feeds, tabs expand to the next tab stop, and every other C0 control,
 * DEL, and C1 control becomes a visible `\xNN` escape. Escaping rather than
 * dropping keeps the text honest about what it contained — a stripped ESC and
 * an absent ESC would look identical — and is what stops untrusted tool output
 * or model text from repainting the screen, moving the cursor, or setting the
 * pane title.
 * @param text - arbitrary text from a model, tool, file, or diagnostic.
 * @returns text whose only remaining control character is the line feed.
 */
export function displayText(text: string): string {
  let out = ''
  let column = 0
  for (const character of text) {
    const code = character.codePointAt(0)
    /* v8 ignore next -- string iteration yields no empty character */
    if (code === undefined) continue
    if (code === LINE_FEED) {
      out += '\n'
      column = 0
      continue
    }
    if (character === '\r') {
      // A lone CR and the CR of a CRLF pair collapse the same way: the next
      // character decides whether a line feed follows, and a duplicate blank
      // line would be worse than dropping the carriage return here.
      continue
    }
    if (character === '\t') {
      const spaces = expandTab(column)
      out += spaces
      column += spaces.length
      continue
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      const escaped = escapeControl(code)
      out += escaped
      column += escaped.length
      continue
    }
    out += character
    column += 1
  }
  return out
}

/**
 * Normalize text for a single-line slot (a card header, a status field, a pane
 * title) by folding every line break into a space after {@link displayText}.
 * @param text - arbitrary text destined for a one-line slot.
 * @returns single-line text with no control characters.
 */
export function displayLine(text: string): string {
  return displayText(text).replaceAll('\n', ' ')
}
