/**
 * The human-facing `/credential` command: the terminal's write path into the
 * credential seam, where the web Models page is the other writer. It stores a
 * value through `ctx.credentials.set` — never into a `.env` — and answers a
 * bare reference with the value-free `describe` facts. The value is a typed
 * argument: the input line is not masked, so nothing pretends otherwise.
 * @module @deepseek-ai/dsh-command-credential
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'command-credential'
// Only the registry is injected: it is what the loader must resolve before the
// command exists, and gating on the credentials service would delay
// registration until that provider finishes loading — after a fast terminal is
// already answering `/help`. The service is read at execution time instead.
export const inject = ['commands']

const USAGE = 'Usage: /credential <REF> [<value>] — REF is an environment-variable name such as DEEPSEEK_API_KEY'

/** The replacement a redaction guard prints where a provider error carried the value. */
const REDACTED = '<redacted>'

/**
 * Remove every occurrence of the stored value from one rendered error. The
 * seam's providers reject without values today; this guard keeps the "never
 * logged" property when a future provider's message is less careful.
 * @param text - the rendered provider failure.
 * @param value - the secret the command was asked to store.
 * @returns the text with the value replaced by a redaction marker.
 */
export function redactValue(text: string, value: string): string {
  if (value === '') return text
  return text.split(value).join(REDACTED)
}

/**
 * Describe one reference for a reader: the value-free configured/source/writable
 * facts as one line, with the write command named where a write is possible.
 * @param ref - the reference described.
 * @param info - the seam's value-free description.
 * @returns the reader-facing line.
 */
export function describeLine(ref: CredentialRef, info: CredentialInfo): string {
  if (!info.configured) {
    return info.writable
      ? `${ref}: not configured; store a value with /credential ${ref} <value>`
      : `${ref}: not configured, and this deployment cannot store one`
  }
  const source = info.source ?? 'an unknown source'
  if (info.writable) return `${ref}: configured from ${source}`
  return `${ref}: configured read-only from ${source}; storing a value would be shadowed by it`
}

/**
 * Parse one command line into its reference and optional value. The first
 * whitespace-delimited token is the reference; the remainder, outer whitespace
 * discarded, is the value — an empty remainder asks for a description instead.
 * @param rawInput - the exact text following the command name.
 * @returns the parsed reference and value, or a usage error.
 */
export function parseInput(rawInput: string):
  | { kind: 'describe'; refText: string }
  | { kind: 'store'; refText: string; value: string }
  | { kind: 'error'; text: string } {
  const input = rawInput.trim()
  if (input === '') return { kind: 'error', text: USAGE }
  const separator = input.search(/\s/u)
  const refText = separator === -1 ? input : input.slice(0, separator)
  if (separator === -1) return { kind: 'describe', refText }
  const value = input.slice(separator + 1).trim()
  if (value === '') return { kind: 'describe', refText }
  return { kind: 'store', refText, value }
}

/**
 * Execute one `/credential` line against the mounted credentials service. A
 * bare reference answers with the value-free description; a reference plus
 * value stores it. Every returned text is value-free: the stored value never
 * reaches the session log, the transcript, or a model request.
 * @param ctx - plugin context used to read the credentials service.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @returns the command outcome drawn as a notice by the dispatching surface.
 */
async function executeCredentialCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    return { kind: 'error', text: 'no credentials service is mounted, so nothing can store or describe this reference' }
  }
  let ref: CredentialRef
  try {
    ref = credentialRef(parsed.refText)
  } catch (error: unknown) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
  if (parsed.kind === 'describe') {
    return { kind: 'success', text: describeLine(ref, await credentials.describe(ref)) }
  }
  const { value } = parsed
  try {
    await credentials.set(ref, value)
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: redactValue(text, value) }
  }
  // The acknowledgement names only the reference: consumers resolve per
  // operation, so the stored value reaches the next request without a restart.
  return { kind: 'success', text: `Stored ${ref}; the next request resolves it.` }
}

/** Register the global `/credential` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'credential',
    description: 'show or store a credential through the credentials service',
    input: { hint: '<REF> [<value>]' },
    // The input carries the secret itself, which no logged event may hold.
    recordInput: false,
    handler: invocation => executeCredentialCommand(ctx, invocation),
  })
}
