/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tui`.
 * @module @deepseek-ai/dsh-tui/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tui'

/** Cordis companion plugin name. */
export const name = 'tui-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package holds only presentation state derived
 * from one session log — the transcript fold is a pure function of the events
 * it replays, and re-reading the log is the same computation the audit would
 * perform. It registers into no shared registry and mutates no data another
 * plugin can observe, so its observable contract is terminal output, which the
 * package's terminal-state tests own.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
