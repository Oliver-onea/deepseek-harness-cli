/**
 * The TUI palette: semantic styles drawn at the deepest color depth the
 * deployment supports. The ladder is truecolor, then 256-color, then the
 * 16-color ANSI set, then no color; body text and backgrounds stay at
 * terminal defaults so a host terminal's light or dark theme keeps its
 * contrast, and selection stays reverse video for the same reason.
 * @module @deepseek-ai/dsh-tui/theme
 */

/** One styling function; identity when the palette is colorless. */
export type Style = (text: string) => string

/** The color depths the palette draws at, deepest first. */
export type ColorDepth = 'truecolor' | '256' | '16'

/**
 * What the terminal environment states about color support, a subset of
 * `process.env` shaped for testing.
 */
export interface ColorEnvironment {
  /** The terminal's advertised color capability, e.g. `truecolor` or `24bit`. */
  COLORTERM?: string | undefined
  /** The terminal type, e.g. `xterm-256color`. */
  TERM?: string | undefined
}

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
  /** Product chrome: the brand mark, the header name, the assistant marker. */
  accent: Style
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

/**
 * Style with one truecolor foreground.
 * @param r - red, 0-255.
 * @param g - green, 0-255.
 * @param b - blue, 0-255.
 * @returns the style.
 */
function rgb(r: number, g: number, b: number): Style {
  return sgr(`38;2;${r};${g};${b}`, '39')
}

/**
 * Style with one 256-color foreground.
 * @param code - the xterm-256 color index.
 * @returns the style.
 */
function indexed(code: number): Style {
  return sgr(`38;5;${code}`, '39')
}

/** The colorless palette every role shares when `color` is off. */
const PLAIN: Style = text => text

/**
 * The role colors at each depth. Truecolor carries the brand palette; the
 * lower tiers approximate it within their fixed sets, so a role never loses
 * its meaning as the terminal loses fidelity.
 */
const TIERS: Record<ColorDepth, Palette> = {
  truecolor: {
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    user: rgb(0x56, 0xc8, 0xe8),
    tool: rgb(0x4d, 0x6b, 0xfe),
    accent: rgb(0x4d, 0x6b, 0xfe),
    success: rgb(0x3f, 0xb9, 0x50),
    warn: rgb(0xe0, 0xaf, 0x68),
    error: rgb(0xf8, 0x51, 0x49),
    removed: rgb(0xf8, 0x51, 0x49),
    added: rgb(0x3f, 0xb9, 0x50),
    code: rgb(0xa7, 0x8b, 0xfa),
    // Reverse video rather than a background color: it inverts whatever the
    // host terminal already uses, so selection stays legible in both themes.
    selected: sgr('7', '27'),
  },
  '256': {
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    user: indexed(81),
    tool: indexed(69),
    accent: indexed(69),
    success: indexed(71),
    warn: indexed(178),
    error: indexed(203),
    removed: indexed(203),
    added: indexed(71),
    code: indexed(147),
    selected: sgr('7', '27'),
  },
  '16': {
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    user: sgr('36', '39'),
    tool: sgr('34', '39'),
    accent: sgr('34', '39'),
    success: sgr('32', '39'),
    warn: sgr('33', '39'),
    error: sgr('31', '39'),
    removed: sgr('31', '39'),
    added: sgr('32', '39'),
    code: sgr('35', '39'),
    selected: sgr('7', '27'),
  },
}

/**
 * Read the color depth a terminal environment advertises: `COLORTERM` states
 * truecolor outright, a `TERM` naming 256 colors states that tier, and
 * anything else falls back to the 16-color set every ANSI terminal carries.
 * @param env - the terminal environment.
 * @returns the advertised depth.
 */
export function detectColorDepth(env: ColorEnvironment): ColorDepth {
  const colorterm = env.COLORTERM?.toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  if (env.TERM?.toLowerCase().includes('256color') === true) return '256'
  return '16'
}

/**
 * Build the palette for one TUI instance.
 * @param color - whether to emit SGR sequences at all.
 * @param depth - the color depth to draw at; ignored when `color` is off and
 * the 16-color tier when omitted, so a direct caller still gets a palette.
 * @returns the role-keyed styles the renderer uses.
 */
export function createPalette(color: boolean, depth: ColorDepth = '16'): Palette {
  if (!color) {
    return {
      dim: PLAIN, bold: PLAIN, user: PLAIN, tool: PLAIN, accent: PLAIN,
      success: PLAIN, warn: PLAIN, error: PLAIN, removed: PLAIN, added: PLAIN,
      code: PLAIN, selected: PLAIN,
    }
  }
  return { ...TIERS[depth] }
}
