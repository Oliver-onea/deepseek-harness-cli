/**
 * Startup-failure classification shared by app plugins and process launchers.
 * @module @deepseek-ai/dsh-app-boot/errors
 */

/**
 * An expected startup refusal caused by user input or deployment configuration.
 * Process launchers render its message without a stack. Unmarked failures remain
 * internal crashes and retain their ordinary runtime diagnostics.
 */
export class StartupRefusalError extends Error {
  /**
   * Create a user-correctable startup refusal.
   * @param message - one-line diagnostic for the process edge.
   * @param options - standard error options, including an underlying cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StartupRefusalError'
  }
}

/** Process-edge classification for one startup failure. */
export type StartupFailure =
  | { kind: 'refusal'; message: string }
  | { kind: 'crash'; error: unknown }

/**
 * Find a typed refusal through standard Error causes. Loader and boot wrappers
 * may add context while preserving the plugin's original refusal as a cause.
 * @param error - startup failure caught at the process edge.
 * @returns the clean refusal message, or the original crash unchanged.
 */
export function classifyStartupFailure(error: unknown): StartupFailure {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof StartupRefusalError) {
      return { kind: 'refusal', message: current.message }
    }
    seen.add(current)
    current = current.cause
  }
  return { kind: 'crash', error }
}
