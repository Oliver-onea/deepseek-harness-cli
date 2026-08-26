/**
 * The cold-open header: the whale mark, the product name and version, the
 * route, the permission preset, the working directory, and one line of hints,
 * composed once at startup so it scrolls away with the transcript after the
 * first turn. The whale only draws where the color depth and the terminal
 * size can carry it; everywhere else a one-line identity header takes its
 * place.
 * @module @deepseek-ai/dsh-tui/header
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { displayLine } from './display-text.ts'
import { collapseHome } from './resume-picker.ts'
import type { ColorDepth } from './theme.ts'
import type { Palette } from './theme.ts'
import { renderWhale } from './whale.ts'

/** Everything the cold-open header reports. */
export interface ColdOpenInput {
  /** The provider route requests will go to. */
  provider: string
  /** The model id requests will go to. */
  model: string
  /** The effective permission preset, when the composition mounts one. */
  permissionPreset?: string | undefined
  /** The working directory the session runs in. */
  cwd: string
  /** The color depth the palette draws at, if any. */
  depth: ColorDepth | undefined
  /** The terminal width in columns. */
  columns: number
  /** The terminal height in rows. */
  rows: number
}

/** Minimum columns for the whale to appear at all. */
const MIN_WHALE_COLUMNS = 60

/** Minimum rows for the stacked whale: its lines plus the editor chrome. */
const STACKED_MIN_ROWS = 20

/** Minimum rows for the lockup whale: its lines plus the editor chrome. */
const LOCKUP_MIN_ROWS = 16

/** Minimum columns to place the identity text beside the whale. */
const LOCKUP_COLUMNS = 78

/** Visible columns the whale occupies, including the gap before the text. */
const WHALE_COLUMN = 30

/**
 * Read this package's version from its checked-in manifest. The source tree
 * and the bundled artifact both sit one directory under the package root, so
 * the same relative hop resolves from either.
 * @returns the package version, or `0.0.0` when the manifest is unreadable.
 */
export function readPackageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Pad a styled string with spaces to a visible width.
 * @param line - the styled line.
 * @param width - the visible width to reach.
 * @returns the padded line.
 */
function padVisible(line: string, width: number): string {
  const gap = width - visibleWidth(line)
  return gap > 0 ? line + ' '.repeat(gap) : line
}

/**
 * Compose the identity text lines that name the session.
 * @param input - the session facts to name.
 * @param palette - the styles to draw with.
 * @param version - the product version.
 * @param hint - whether to add the one line of key hints.
 * @returns the styled text lines.
 */
function identityLines(input: ColdOpenInput, palette: Palette, version: string, hint: boolean): string[] {
  const route = `${displayLine(input.provider)}/${displayLine(input.model)}`
  const lines = [
    `${palette.bold('DeepSeek Harness')} ${palette.dim(`v${version}`)}`,
    palette.dim(route),
    palette.dim(displayLine(collapseHome(input.cwd))),
  ]
  if (input.permissionPreset !== undefined) lines.push(palette.dim(displayLine(input.permissionPreset)))
  if (hint) lines.push(palette.dim('/ for commands · @ to mention · ctrl+c to leave'))
  return lines
}

/**
 * Compose the one-line identity header used when the whale cannot draw.
 * @param input - the session facts to name.
 * @param palette - the styles to draw with.
 * @param version - the product version.
 * @returns the single styled line.
 */
function oneLineHeader(input: ColdOpenInput, palette: Palette, version: string): string[] {
  const route = `${displayLine(input.provider)}/${displayLine(input.model)}`
  const preset = input.permissionPreset === undefined ? '' : ` · ${displayLine(input.permissionPreset)}`
  const line = `${palette.bold('DeepSeek Harness')} ${palette.dim(`v${version}`)}`
    + `${palette.dim(' · ')}${palette.dim(route)}${palette.dim(preset)}`
  return [truncateToWidth(line, Math.max(1, input.columns))]
}

/**
 * Compose the cold-open header lines for one startup.
 * @param input - the session facts and terminal geometry.
 * @param palette - the styles to draw with.
 * @returns the styled header lines, ready to seed into the transcript.
 */
export function composeColdOpen(input: ColdOpenInput, palette: Palette): string[] {
  const version = readPackageVersion()
  const whale = renderWhale(input.depth)
  if (whale === undefined || input.columns < MIN_WHALE_COLUMNS) {
    return oneLineHeader(input, palette, version)
  }
  if (input.columns >= LOCKUP_COLUMNS && input.rows >= LOCKUP_MIN_ROWS) {
    // Lockup: whale on the left, identity vertically centered beside it.
    const text = identityLines(input, palette, version, true)
    const pad = Math.max(0, Math.floor((whale.length - text.length) / 2))
    const lines: string[] = []
    for (let row = 0; row < whale.length; row += 1) {
      const whaleLine = whale[row]
      if (whaleLine === undefined) continue
      const textIndex = row - pad
      const right = textIndex >= 0 && textIndex < text.length ? text[textIndex] ?? '' : ''
      lines.push(`${padVisible(whaleLine, WHALE_COLUMN)}${right}`)
    }
    return lines
  }
  if (input.rows >= STACKED_MIN_ROWS) {
    // Stack the whale above the identity when there is no room beside it.
    return [...whale, ...identityLines(input, palette, version, false)]
  }
  return oneLineHeader(input, palette, version)
}
