/**
 * Keystroke-driven PTY acceptance for the shipped `dsh` terminal.
 *
 * These cases prove the reusable harness in `tui-interaction.harness.ts` by
 * exercising the real terminal profile against the keyless mock model. They
 * are intentionally PTY-based because the subject is terminal takeover.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createTuiHarness, DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from './tui-interaction.harness.ts'

const ANSWER = 'Mock model answering the terminal.'

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
