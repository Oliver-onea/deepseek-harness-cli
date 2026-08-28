/**
 * The DeepSeek whale mark for the cold-open header. The pixel map samples the
 * official SVG path (`apps/web/public/favicon.svg`, viewBox `0 0 50 50`) at a
 * fixed resolution without redrawing the contour; half-block cells pack two
 * pixel rows per terminal row. The map is committed, not rasterized at
 * runtime, and carries no ANSI of its own.
 * @module @deepseek-ai/dsh-tui/whale
 */

import type { ColorDepth } from './theme.ts'

/**
 * The mark's body pixels, one row per source pixel row. The header draws at
 * most at this fidelity; smaller terminals get the one-line identity header
 * instead of a scaled-down whale.
 */
const WHALE_PIXELS: readonly string[] = [
  '..........................',
  '.......#..###....##.......',
  '....#########....###.....#',
  '..############...####.####',
  '.##############...#######.',
  '.###############..#######.',
  '#################..#####..',
  '##...#############.###....',
  '##.....#######..######....',
  '##.......######.######....',
  '##........#####..####.....',
  '##.........#####.####.....',
  '.##.........#########.....',
  '.##.........########......',
  '.###.........######.......',
  '..###....##...####........',
  '...####..###...####.......',
  '....##########..#####.....',
  '.....##########...........',
  '........#####.............',
]

/** The truecolor brand ink, `#4D6BFE`. */
const BRAND_TRUECOLOR = '\x1b[38;2;77;107;254m'

/** The nearest xterm-256 ink to the brand blue. */
const BRAND_256 = '\x1b[38;5;69m'

/** The foreground reset closing one styled whale line. */
const FOREGROUND_CLOSE = '\x1b[39m'

/**
 * Whether the whale draws at a color depth. Half-block curves need paired
 * foreground shades to read as the mark; the 16-color tier and no-color both
 * fall back to the one-line identity header instead.
 * @param depth - the palette's depth, or `undefined` for no color.
 * @returns whether the whale can carry the header.
 */
export function whaleDepthSupported(depth: ColorDepth | undefined): boolean {
  return depth === 'truecolor' || depth === '256'
}

/**
 * Render the whale as styled half-block lines.
 * @param depth - the palette's depth, or `undefined` for no color.
 * @returns the whale's lines, or `undefined` when the depth cannot carry it.
 */
export function renderWhale(depth: ColorDepth | undefined): readonly string[] | undefined {
  if (!whaleDepthSupported(depth)) return undefined
  const ink = depth === 'truecolor' ? BRAND_TRUECOLOR : BRAND_256
  const lines: string[] = []
  for (let y = 0; y < WHALE_PIXELS.length; y += 2) {
    const top = WHALE_PIXELS[y]
    if (top === undefined) continue
    const bottom = WHALE_PIXELS[y + 1] ?? ''
    let cells = ''
    for (let x = 0; x < top.length; x += 1) {
      const upper = top[x] === '#'
      const lower = bottom[x] === '#'
      cells += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' '
    }
    const trimmed = cells.replace(/\s+$/u, '')
    lines.push(trimmed === '' ? '' : `${ink}${trimmed}${FOREGROUND_CLOSE}`)
  }
  return lines
}
