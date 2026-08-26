/**
 * Keystroke-driven PTY acceptance for the shipped `dsh` terminal.
 *
 * These cases prove the reusable harness in `tui-interaction.harness.ts` by
 * exercising the real terminal profile against the keyless mock model. They
 * are intentionally PTY-based because the subject is terminal takeover.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createTuiHarness, DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from './tui-interaction.harness.ts'

const ANSWER = 'Mock model answering the terminal.'

const STAGE_CHILD_PLUGIN = fileURLToPath(new URL('./fixtures/tui-journey/stage-subagent-child.ts', import.meta.url))
const STAGE_SKILL_PLUGIN = fileURLToPath(new URL('./fixtures/tui-journey/stage-skill.ts', import.meta.url))

/**
 * Normalize screen output for snapshot stability. Elapsed seconds in the
 * running-turn footer vary between runs; everything else (command roster,
 * route names, model catalog, child label) is deterministic under the
 * keyless mock and the default terminal geometry.
 */
function normalizeScreen(screen: string): string {
  return screen.replace(/\bworking \d+s\b/g, 'working <N>s')
}

/**
 * Build a temporary Cordis patch that inserts the subagent-child staging
 * plugin, so the `@` menu can list a real running child without a model turn.
 * The patch file uses an absolute file URL because Cordis plugin names must
 * resolve; the temp directory is cleaned up by the caller.
 */
function createStageChildPatch(): { patch: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-journey-patch-'))
  const patch = join(dir, 'cordis.patch.yml')
  writeFileSync(patch, [
    '- insert:',
    '    - id: tui-journey-stage-child',
    `      name: ${pathToFileURL(STAGE_CHILD_PLUGIN).href}`,
    '',
  ].join('\n'))
  return { patch, dir }
}

/**
 * Build a temporary Cordis patch that inserts the skill staging plugin, so the
 * `/` menu can list a real user-invocable skill without a model turn.
 */
function createStageSkillPatch(): { patch: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-journey-patch-'))
  const patch = join(dir, 'cordis.patch.yml')
  writeFileSync(patch, [
    '- insert:',
    '    - id: tui-journey-stage-skill',
    `      name: ${pathToFileURL(STAGE_SKILL_PLUGIN).href}`,
    '',
  ].join('\n'))
  return { patch, dir }
}

describe('dsh terminal interaction under a real PTY', () => {
  let server: MockLlmServer | undefined

  beforeAll(async () => {
    server = await startMockLlmServer({
      apiKey: 'mock-key',
      sequence: ['success'],
      repeatLast: true,
      successText: ANSWER,
    })
  })

  afterAll(async () => { await server?.close() })

  it('cold-open renders the footer with run state and route', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      const screen = harness.snapshot()
      expect(screen).toContain('ready')
      expect(screen).toContain('deepseek-official/deepseek-v4-flash')
      expect(screen).toContain('/help')
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS)

  it('submits a typed line and shows it in the transcript', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.submit('hello there')
      await harness.waitFor('hello there', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor(ANSWER, DEFAULT_TURN_TIMEOUT_MS)
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 3)
})

describe('dsh terminal journey snapshots', () => {
  let server: MockLlmServer | undefined

  beforeAll(async () => {
    server = await startMockLlmServer({
      apiKey: 'mock-key',
      sequence: ['success'],
      repeatLast: true,
      successText: ANSWER,
    })
  })

  afterAll(async () => { await server?.close() })

  it('slash menu opens, filters, and dispatches a pick', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.type('/he')
      await harness.waitFor('help', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('List the commands this terminal resolves', DEFAULT_TURN_TIMEOUT_MS)
      harness.key('enter')
      await harness.waitFor('/help — List the commands this terminal resolves', DEFAULT_TURN_TIMEOUT_MS)
      // A second listing forces the scroll view to settle the full roster:
      // the first paint can clip against the not-yet-grown content height.
      harness.submit('/help')
      await harness.waitUntil(
        screen => (screen.match(/\/quit — Leave the terminal session/gu) ?? []).length === 2,
        DEFAULT_TURN_TIMEOUT_MS,
      )
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 3)

  it('/help lists the live command registry as text', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.submit('/help')
      await harness.waitFor('/help — List the commands this terminal resolves', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('/exit — Leave the terminal session', DEFAULT_TURN_TIMEOUT_MS)
      // A second listing forces the scroll view to settle the full roster:
      // the first paint can clip against the not-yet-grown content height.
      harness.submit('/help')
      await harness.waitUntil(
        screen => (screen.match(/\/quit — Leave the terminal session/gu) ?? []).length === 2,
        DEFAULT_TURN_TIMEOUT_MS,
      )
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 2)

  it('@ menu offers a running child and a pick lands the reference in the composer', async () => {
    const { patch, dir } = createStageChildPatch()
    const harness = createTuiHarness({
      baseUrl: server?.baseURL ?? '',
      args: ['--patch', patch],
    })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.type('@')
      await harness.waitFor('journey-child', DEFAULT_TURN_TIMEOUT_MS)
      harness.key('enter')
      // The pick inserts `@journey-child ` with a trailing space. Plain-text
      // snapshots strip trailing whitespace, so type a visible character to
      // prove the cursor landed after the inserted reference.
      harness.type('x')
      await harness.waitFor('@journey-child x', DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.cancel()).toBe(0)
    } finally {
      await harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 3)

  it('@ menu offers nothing when no child is running', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.type('@')
      // With no running child the menu never opens, so the `@` stays in the
      // composer and no roster text appears.
      await harness.waitFor('@', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitUntil(
        screen => !screen.includes('journey-child'),
        DEFAULT_TURN_TIMEOUT_MS,
      )
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.cancel()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 2)

  it('/ menu lists a staged skill and a pick submits it as a prompt', async () => {
    const { patch, dir } = createStageSkillPatch()
    const harness = createTuiHarness({
      baseUrl: server?.baseURL ?? '',
      args: ['--patch', patch],
    })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.type('/jou')
      await harness.waitFor('journey-skill', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('A staged skill for journey snapshots', DEFAULT_TURN_TIMEOUT_MS)
      harness.key('enter')
      // A skill pick is not a command, so the line ships to the model verbatim
      // and the mock answers it; the transcript shows the user prompt and the
      // assistant response.
      await harness.waitFor('/journey-skill', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor(ANSWER, DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 4)

  it('/model opens the picker, esc dismisses, and enter applies', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)

      harness.submit('/model')
      await harness.waitFor('Model', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('deepseek-official/deepseek-v4-pro', DEFAULT_TURN_TIMEOUT_MS)
      harness.key('esc')
      await harness.waitUntil(
        screen => !screen.includes('Model') && !screen.includes('deepseek-official/deepseek-v4-pro'),
        DEFAULT_TURN_TIMEOUT_MS,
      )

      harness.submit('/model')
      await harness.waitFor('Model', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('deepseek-official/deepseek-v4-pro', DEFAULT_TURN_TIMEOUT_MS)
      harness.key('down')
      harness.key('enter')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-pro', DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 5)

  it('/model drills into a route effort tier and applies the picked effort', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)

      harness.submit('/model')
      await harness.waitFor('Model', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('deepseek-official/deepseek-v4-pro', DEFAULT_TURN_TIMEOUT_MS)
      harness.key('down')
      harness.key('right')
      await harness.waitFor('Effort', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('off — Off', DEFAULT_TURN_TIMEOUT_MS)
      harness.type('2')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-pro (reasoning off)', DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 5)

  it('/model <route> <effort> selects directly and reports the pinned effort', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.submit('/model deepseek-v4-pro off')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-pro (reasoning off)', DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 3)

  it('/model <route> <effort> rejects an unknown effort at pick time naming what is available', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.submit('/model deepseek-v4-pro turbo')
      await harness.waitFor('unknown effort "turbo" for deepseek-official/deepseek-v4-pro', DEFAULT_TURN_TIMEOUT_MS)
      await harness.waitFor('available: default, off, high, max', DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 3)

  it('/model reports was <effort> when a pick replaces a stored explicit effort', async () => {
    const harness = createTuiHarness({ baseUrl: server?.baseURL ?? '' })
    try {
      await harness.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
      harness.submit('/model deepseek-v4-pro off')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-pro (reasoning off)', DEFAULT_TURN_TIMEOUT_MS)
      harness.submit('/model deepseek-v4-flash')
      await harness.waitFor('Model switched to deepseek-official/deepseek-v4-flash (reasoning high, was off)', DEFAULT_TURN_TIMEOUT_MS)
      expect(normalizeScreen(harness.snapshot())).toMatchSnapshot()
      expect(await harness.exit()).toBe(0)
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 5)

  it('a bare --resume opens the launch picker and enter resumes the persisted session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-pick-'))
    try {
      const first = createTuiHarness({ baseUrl: server?.baseURL ?? '', home })
      try {
        await first.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
        first.submit('hello there')
        await first.waitFor(ANSWER, DEFAULT_TURN_TIMEOUT_MS)
        expect(await first.exit()).toBe(0)
      } finally {
        await first.dispose()
      }
      const second = createTuiHarness({ baseUrl: server?.baseURL ?? '', home, args: ['--resume'] })
      try {
        await second.waitFor('Resume a session', DEFAULT_BOOT_TIMEOUT_MS)
        await second.waitFor('enter resumes', DEFAULT_TURN_TIMEOUT_MS)
        second.key('enter')
        // The picked id boots through the same path a named resume takes:
        // the replayed transcript and the footer appear with no re-prompt.
        await second.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
        await second.waitFor('hello there', DEFAULT_TURN_TIMEOUT_MS)
        await second.waitFor(ANSWER, DEFAULT_TURN_TIMEOUT_MS)
        expect(await second.exit()).toBe(0)
      } finally {
        await second.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, (DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 2) * 2)

  it('a bare --resume with esc refuses startup without resuming or creating anything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-esc-'))
    try {
      const first = createTuiHarness({ baseUrl: server?.baseURL ?? '', home })
      try {
        await first.waitFor('ready', DEFAULT_BOOT_TIMEOUT_MS)
        first.submit('hello there')
        await first.waitFor(ANSWER, DEFAULT_TURN_TIMEOUT_MS)
        expect(await first.exit()).toBe(0)
      } finally {
        await first.dispose()
      }
      const second = createTuiHarness({ baseUrl: server?.baseURL ?? '', home, args: ['--resume'] })
      try {
        await second.waitFor('Resume a session', DEFAULT_BOOT_TIMEOUT_MS)
        second.key('esc')
        await second.waitFor('no session chosen', DEFAULT_TURN_TIMEOUT_MS)
        await second.waitFor('name one with dsh --resume', DEFAULT_TURN_TIMEOUT_MS)
      } finally {
        await second.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, (DEFAULT_BOOT_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS * 2) * 2)
})
