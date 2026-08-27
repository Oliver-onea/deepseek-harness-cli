/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-command-credential`.
 * @module @deepseek-ai/dsh-command-credential/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-credential'

/** Cordis companion plugin name. */
export const name = 'command-credential-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session events and owns no
 * mutable data — `command/run`/`command/done` belong to `dsh-commands`, and
 * the stored value lives in the credentials provider's source, whose own
 * package checks the relationships it owns.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
