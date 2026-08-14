/** Product CLI snapshot for a designed startup refusal through a real profile composition. */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const placeholderConfig = fileURLToPath(new URL('../../../packages/bundle/tui-app/cordis.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('dsh startup-refusal snapshots', () => {
  it('prints the TTY requirement as one clean line through the shipped tui profile', async () => {
    const result = await runLoaderSmoke({
      label: 'product tui non-TTY startup refusal',
      tempDirPrefix: 'dsh-snapshot-tui-refusal-',
      binScript: dshBinScript,
      configPath: placeholderConfig,
      binArgs: [],
      tsconfigPath,
      expectedExitCode: 1,
      env: { DSH_TELEMETRY_DISABLED: '1' },
    })

    expect(result.stdout).toBe('')
    expect(result.stderr).toMatchInlineSnapshot(`
      "dsh-tui: the terminal front door needs a TTY on both stdin and stdout; use the headless app for pipes and automation
      "
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
