/**
 * Keyless credential-failure journeys for the shipped terminal profile.
 *
 * The scenario is keyless by nature — there is no key to configure — so these
 * boots run the real `dsh --profile tui` with no credential in any layer and
 * pin what the reader sees: the failure the unanswered prompt reports, the
 * single notice a repeated send keeps, and the replay a resume draws.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTuiHarness, DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from './tui-interaction.harness.ts'

/** The harness child env models absence with an empty value; every layer reads empty as unset. */
const KEYLESS_ENV = { DEEPSEEK_API_KEY: '' }

/**
 * No mock server runs for this journey: a keyless request fails credential
 * resolution before any network use, so the base URL is never reached.
 */
const UNREACHED_BASE_URL = 'http://127.0.0.1:9'

/** Elapsed seconds in the running-turn footer vary between runs. */
function normalizeScreen(screen: string): string {
  return screen.replace(/\bworking \d+s\b/g, 'working <N>s')
}

/** The one stored session id under a harness home that ran exactly one session. */
function storedSessionId(home: string): string {
  const project = readdirSync(join(home, 'sessions'))[0]!
  const session = readdirSync(join(home, 'sessions', project))[0]!
  return session
}

describe('dsh keyless credential journey snapshots', () => {
  it('reports the missing credential once, stays usable, and survives resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-keyless-'))
    try {
      const harness = createTuiHarness({ baseUrl: UNREACHED_BASE_URL, env: KEYLESS_ENV, home })
      try {
        await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
        harness.submit('say hi')
        await harness.waitFor('MISSING_CREDENTIAL', DEFAULT_TURN_TIMEOUT_MS)
        // A resend against the unchanged failure must not stack an identical
        // notice: wait the second turn out, then count the failure lines.
        harness.submit('say hi again')
        await harness.waitUntil(screen => /working \d+s/u.test(screen), DEFAULT_TURN_TIMEOUT_MS)
        await harness.waitUntil(screen => screen.includes('ready'), DEFAULT_TURN_TIMEOUT_MS)
        expect(harness.snapshot().match(/MISSING_CREDENTIAL/gu) ?? []).toHaveLength(1)
        // The input line still accepts the next message.
        harness.type('still usable')
        await harness.waitFor('still usable', DEFAULT_TURN_TIMEOUT_MS)
        expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
        // Leave through ctrl+c: `/exit` would append to the unsubmitted input
        // text above and submit the joined line as a prompt instead of exiting.
        expect(await harness.cancel()).toBe(0)
      } finally {
        await harness.dispose()
      }

      const second = createTuiHarness({
        baseUrl: UNREACHED_BASE_URL,
        env: KEYLESS_ENV,
        home,
        args: ['--resume', storedSessionId(home)],
      })
      try {
        await second.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
        // The replayed log carries the same failure as exactly one notice.
        await second.waitFor('MISSING_CREDENTIAL', DEFAULT_TURN_TIMEOUT_MS)
        expect(second.snapshot()).toContain('say hi')
        expect(second.snapshot().match(/MISSING_CREDENTIAL/gu) ?? []).toHaveLength(1)
        expect(normalizeScreen(second.snapshot())).toMatchSnapshot()
        expect(await second.exit()).toBe(0)
      } finally {
        await second.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, (DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 4) * 2)
})
