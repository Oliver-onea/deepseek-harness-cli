/**
 * The `/help` listing: every command the live registry resolves for this
 * agent, one row per command.
 * @module @deepseek-ai/dsh-tui/command-help
 */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { displayLine } from './display-text.ts'

/**
 * Format the command listing the reader asked for. Descriptions and hints come
 * from registrations, so they are normalized for display here.
 * @param commands - descriptors the registry resolves for this agent.
 * @returns one row per command, the roster the `/` menu offers.
 */
export function helpText(commands: readonly CommandDescriptor[]): string {
  return commands.map(command =>
    `/${command.name}${command.input === undefined ? '' : ` ${displayLine(command.input.hint)}`} — ${displayLine(command.description)}`,
  ).join('\n')
}
