/**
 * Keyless snapshot coverage for the TypeScript SDK path: each scenario spawns
 * the REAL `dsh-jsonrpc-agent` runtime (per `DSH_EXAMPLE_MODE`) through the
 * REAL `@deepseek-ai/dsh-sdk-client`, drives one turn — or a prompt → queue →
 * interrupt flow — over stdio JSON-RPC, and pins the SDK-visible result, the
 * complete notification stream, and the persisted session logs. Replay serves
 * recorded model responses via `llm-replay` (`cordis.snapshot.yml`);
 * `DSH_SNAPSHOT=record` re-records against the live API; `DSH_SNAPSHOT=refresh`
 * replays committed fixtures and rewrites expected outputs.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  normalizeSessionLog,
  normalizeStdout,
  refreshFixtureReplacements,
  scrubRequestHeaders,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  type HarvestedLog,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { DeepSeekHarness, type ContentBlock, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'

const testsDir = dirOf(import.meta.url)
const snapshotsDir = join(testsDir, 'snapshots')
const liveConfig = join(testsDir, '..', 'cordis.yml')
const replayConfig = join(testsDir, '..', 'cordis.snapshot.yml')
const minimalLiveConfig = join(testsDir, '..', 'minimal.cordis.yml')
const minimalReplayConfig = join(testsDir, '..', 'minimal.snapshot.cordis.yml')
const runtimeBin = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const MINIMAL_SYSTEM_PROMPT = 'You are the environment-selected minimal software engineer.'
const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

const mode = process.env.DSH_SNAPSHOT ?? 'replay'
const recording = mode === 'record'
const refreshing = mode === 'refresh'

function dirOf(url: string): string {
  return fileURLToPath(new URL('.', url))
}

interface SdkScenario {
  /** Scenario name; the snapshots/<name> fixture directory. */
  name: string
  /** The user prompt for the first (or only) SDK turn. */
  prompt: string
  /** Fixed SDK session id, so fixtures and replay binding stay stable. */
  sessionId: string
  /** How many child sessions the turn persists (subagent scenarios). */
  children: number
  /**
   * Authored prompt → queue → interrupt flow driven over `HarnessClient`
   * instead of `harness.run`: the first prompt hangs mid-stream (replay
   * `hang` entry), `queuedPrompt` is then discarded (default) or parked
   * (`keepInbox`) until `wakePrompt` claims it. Replay/refresh only — a live
   * hang is not recordable.
   */
  interrupt?: { queuedPrompt: string; keepInbox?: boolean; wakePrompt?: string }
  /** Optional scenario-specific live and replay compositions. */
  configs?: { live: string; replay: string }
  /** Environment overrides passed to the runtime subprocess. */
  environment?: Readonly<Record<string, string>>
  /** Cwd-relative files whose final contents are part of the scenario contract. */
  expectedFiles?: Readonly<Record<string, string>>
  /** Assembled model-facing tool names and required argument keys. */
  expectedTools?: Readonly<Record<string, readonly string[]>>
  /** Exact assembled system prompt for the root request. */
  expectedSystem?: string
  /** Exact model-facing descriptions for selected tools. */
  expectedToolDescriptions?: Readonly<Record<string, string>>
  /** Expected runtime-context state in the real assembled request. */
  runtimeContext?: false | { includes: readonly string[]; excludes: readonly string[] }
}

const SCENARIOS: SdkScenario[] = [
  {
    name: 'text-turn',
    prompt: 'Reply with exactly: SDK snapshot OK',
    sessionId: 'sdk-snapshot-text',
    children: 0,
  },
  {
    name: 'bash-tool',
    prompt: 'Run this exact command with your bash tool, then reply with its stdout only: echo dsh-sdk-proof-7391',
    sessionId: 'sdk-snapshot-bash',
    children: 0,
  },
  {
    name: 'subagent-spawn-in-process',
    prompt: "Use the subagent tool exactly once with description 'echo probe' and prompt: Reply with exactly: child answer 42. Then reply with the subagent's final answer verbatim.",
    sessionId: 'sdk-snapshot-subagent',
    children: 1,
  },
  {
    name: 'persistent-tools',
    prompt: 'Prove that bash state persists. Then create {{cwd}}/note.txt with a tab-indented line, view it, replace that literal tab-indented line, and make the persistent shell exit with code 9.',
    sessionId: 'persistent-tools-snapshot',
    children: 0,
    configs: { live: minimalLiveConfig, replay: minimalReplayConfig },
    environment: { DSH_SYSTEM_PROMPT: MINIMAL_SYSTEM_PROMPT },
    expectedFiles: { 'note.txt': 'target:\n\tnew\n' },
    expectedTools: { bash: ['command'], str_replace_editor: ['command', 'path'] },
    expectedSystem: MINIMAL_SYSTEM_PROMPT,
    expectedToolDescriptions: { bash: MINIMAL_BASH_DESCRIPTION },
    runtimeContext: false,
  },
  {
    // Keyless authored scenario (like the ACP `cancel`): the replay `hang`
    // entry stalls mid-stream so the interrupt lands deterministically; the
    // default clears the queued prompt.
    name: 'interrupt',
    prompt: 'Write a long essay; the client interrupts it mid-stream.',
    sessionId: 'sdk-snapshot-interrupt',
    children: 0,
    interrupt: { queuedPrompt: 'Queued behind the hang; the default interrupt discards this.' },
  },
  {
    // Same hang, but `keepInbox` parks the queued prompt instead of
    // discarding it; the wake prompt claims the parked work afterwards.
    name: 'interrupt-keep-inbox',
    prompt: 'Write a long essay; the client interrupts it mid-stream.',
    sessionId: 'sdk-snapshot-interrupt-keep',
    children: 0,
    interrupt: {
      queuedPrompt: 'Queued behind the hang; keepInbox parks it for the wake prompt.',
      keepInbox: true,
      wakePrompt: 'Wake the parked queue.',
    },
  },
]

interface PersistedLog {
  readonly path: string
  readonly content: string
  readonly header: Record<string, unknown>
}

interface MissingFile {
  readonly missing: true
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.filter(entry => entry.endsWith('.jsonl')).map(entry => join(dir, entry)).sort()
}

async function persistedLogs(sessionsRoot: string): Promise<PersistedLog[]> {
  const files = await jsonlFiles(sessionsRoot)
  return Promise.all(files.map(async (path) => {
    const content = await readFile(path, 'utf8')
    const header = JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>
    return { path, content, header }
  }))
}

interface LoggedRequestHeader {
  type?: string
  data?: { header?: { system?: unknown; tools?: LoggedTool[] } }
}

interface LoggedTool {
  readonly name: string
  readonly description?: unknown
  readonly parameters: { readonly required?: string[] }
}

function assembledTools(log: PersistedLog): LoggedTool[] {
  const event = log.content.trimEnd().split('\n')
    .map(line => JSON.parse(line) as LoggedRequestHeader)
    .find(candidate => candidate.type === 'request/header')
  const tools = event?.data?.header?.tools
  if (tools === undefined) throw new Error('session log has no request/header tools')
  return tools
}

function assembledToolRequirements(log: PersistedLog): Record<string, string[]> {
  return Object.fromEntries(assembledTools(log).map(tool => [tool.name, tool.parameters.required ?? []]))
}

function assembledToolDescriptions(log: PersistedLog): Record<string, string> {
  return Object.fromEntries(assembledTools(log).map((tool) => {
    if (typeof tool.description !== 'string') throw new Error(`tool ${tool.name} has no description`)
    return [tool.name, tool.description]
  }))
}

function assembledSystem(log: PersistedLog): string {
  const event = log.content.trimEnd().split('\n')
    .map(line => JSON.parse(line) as LoggedRequestHeader)
    .find(candidate => candidate.type === 'request/header')
  const system = event?.data?.header?.system
  if (typeof system !== 'string') throw new Error('session log has no request/header system')
  return system
}

function assembledRuntimeContexts(log: PersistedLog): string[] {
  return log.content.trimEnd().split('\n').flatMap((line) => {
    const event = JSON.parse(line) as {
      type?: string
      data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: unknown }> }
    }
    if (event.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== '@deepseek-ai/dsh-system-prompt') return []
    return event.data.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) ?? []
  })
}

function contextOf(logs: readonly { content: string; header: Record<string, unknown> }[], cwd: string): NormalizeContext {
  return {
    sessionIds: logs.flatMap(log => typeof log.header.id === 'string' ? [log.header.id] : []),
    cwd,
  }
}

function contextOfContents(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>)
  return {
    sessionIds: headers.flatMap(header => typeof header.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

/** Hydrated replay inputs: the session fixtures plus the optional `hang`/`throw` sidecar. */
interface HydratedFixtures {
  readonly files: string[]
  readonly override?: string
}

async function hydrateReplayFixtures(scenario: SdkScenario, cwd: string): Promise<HydratedFixtures> {
  const root = join(cwd, '.replay-fixtures')
  await mkdir(root, { recursive: true })
  const hydrate = async (source: string): Promise<string> => {
    const destination = join(root, basename(source))
    await writeFile(destination, (await readFile(source, 'utf8')).replaceAll('{{cwd}}', cwd))
    return destination
  }
  const files = await Promise.all(fixtureFiles(scenario).map(hydrate))
  const overrideSource = join(snapshotsDir, scenario.name, 'replay.override.json')
  const override = existsSync(overrideSource) ? await hydrate(overrideSource) : undefined
  return { files, ...override === undefined ? {} : { override } }
}

async function readExpectedFile(path: string): Promise<string | MissingFile> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    throw error
  }
}

/**
 * Normalize the SDK-visible notification stream: embedded `session.event`
 * envelopes get the session-log treatment (times zeroed, headers tokenized),
 * then every record is scrubbed like a wire frame.
 */
function normalizeNotifications(notifications: readonly HarnessNotification[], ctx: NormalizeContext): string {
  const events = notifications
    .filter(n => n.method === 'session.event')
    .map(n => n.params.event as Record<string, unknown>)
  const normalizedEvents = events.length === 0
    ? []
    : scrubRequestHeaders(normalizeSessionLog(
      `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      ctx,
    )).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  let eventIndex = 0
  const records = notifications.map((notification) => {
    if (notification.method !== 'session.event') return { method: notification.method, params: notification.params }
    const event = normalizedEvents[eventIndex++]
    return { method: notification.method, params: { ...notification.params, event } }
  })
  return normalizeStdout(`${records.map(record => JSON.stringify(record)).join('\n')}\n`, ctx)
}

/** Normalize the owned-run projection. */
function normalizeResult(result: RunResult, ctx: NormalizeContext): string {
  return normalizeStdout(`${JSON.stringify({
    sessionId: result.sessionId,
    finalResponse: result.finalResponse,
  })}\n`, ctx)
}

/** One owned `harness.run` turn with its notification stream. */
async function runPromptDrive(
  harness: DeepSeekHarness,
  scenario: SdkScenario,
  cwd: string,
): Promise<{ result: RunResult; notifications: HarnessNotification[] }> {
  const notifications: HarnessNotification[] = []
  const result = await harness.run(scenario.prompt.replaceAll('{{cwd}}', cwd), {
    sessionId: scenario.sessionId,
    onNotification: (notification) => { notifications.push(notification) },
  })
  return { result, notifications }
}

/** Marker the replay `hang` entry touches in the runtime's cwd once its prefix chunks streamed. */
const STREAM_READY_FILE = '.dsh-snapshot-stream-ready'

/** Poll for a path the runtime subprocess creates (30s deadline). */
async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The `kind` of every `turn/end` reason in a notification stream, in wire order. */
function turnEndKinds(notifications: readonly HarnessNotification[]): string[] {
  return notifications.flatMap((notification) => {
    if (notification.method !== 'session.event') return []
    const event = notification.params.event as { type?: string; data?: { reason?: { kind?: string } } }
    const kind = event.data?.reason?.kind
    return event.type === 'turn/end' && typeof kind === 'string' ? [kind] : []
  })
}

/** Concatenated text of the last assistant message (the client's `finalResponse` helper is not a package-root export). */
function lastAssistantText(events: RunResult['events']): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}

/**
 * Drive the prompt → queue → interrupt flow over the low-level client: the
 * first prompt hangs mid-stream, the queued prompt is discarded (default) or
 * parked (`keepInbox`), and `wakePrompt` claims the parked work afterwards.
 * The drive settles on the trailing idle status so the pinned stream covers
 * the whole flow.
 */
async function runInterruptDrive(
  harness: DeepSeekHarness,
  scenario: SdkScenario,
  interrupt: NonNullable<SdkScenario['interrupt']>,
  cwd: string,
): Promise<{ result: RunResult; notifications: HarnessNotification[] }> {
  await harness.start()
  const client = harness.client
  const notifications: HarnessNotification[] = []
  const events: RunResult['events'] = []
  const prompt = (text: string): Promise<string> =>
    client.prompt(scenario.sessionId, [{ type: 'text', text }])
  const subscription = client.subscribeSessionTree(scenario.sessionId)
  /** Collect until the session reports idle, gated on `ready` over the stream so far. */
  const drainUntilIdle = async (ready: (collected: readonly HarnessNotification[]) => boolean): Promise<void> => {
    while (true) {
      const notification = await subscription.next()
      notifications.push(notification)
      if (notification.method === 'session.event') {
        // The expected files pin the exact frames; the drive itself needs no
        // per-variant narrowing of the event envelope.
        events.push(notification.params.event as RunResult['events'][number])
      }
      if (notification.method === 'session.status'
        && notification.params.sessionId === scenario.sessionId
        && notification.params.status === 'idle'
        && ready(notifications)) return
    }
  }
  try {
    await prompt(scenario.prompt)
    await prompt(interrupt.queuedPrompt)
    // The hang entry touches the marker only after yielding its prefix
    // chunks, so the interrupt lands deterministically mid-stream.
    await waitForPath(join(cwd, STREAM_READY_FILE))
    await client.interrupt(
      scenario.sessionId,
      interrupt.keepInbox === undefined ? undefined : { keepInbox: interrupt.keepInbox },
    )
    await drainUntilIdle(collected => turnEndKinds(collected).includes('aborted'))
    if (interrupt.wakePrompt !== undefined) {
      await prompt(interrupt.wakePrompt)
      await drainUntilIdle(collected => turnEndKinds(collected).includes('completed'))
    }
  } finally {
    subscription.close()
  }
  return {
    result: { sessionId: scenario.sessionId, finalResponse: lastAssistantText(events), events, notifications },
    notifications,
  }
}

/** One SDK scenario against a fresh runtime subprocess in an isolated cwd. */
async function runScenario(scenario: SdkScenario): Promise<{
  result: RunResult
  notifications: HarnessNotification[]
  logs: PersistedLog[]
  observedFiles: Record<string, string | MissingFile>
  cwd: string
}> {
  const cwd = await mkdtemp(join(tmpdir(), `sdk-snapshot-${scenario.name}-`))
  const sessionsRoot = join(cwd, '.sessions')
  const hydrated: HydratedFixtures = recording ? { files: [] } : await hydrateReplayFixtures(scenario, cwd)
  const launch = resolveExampleLaunch({
    srcBin: runtimeBin,
    configArgs: [],
    tsconfigPath: repoTsconfig,
  })
  const [parentFixture, ...childFixtures] = hydrated.files
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    ...Object.fromEntries(Object.entries(launch.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    DSH_CORDIS_CONFIG: recording
      ? scenario.configs?.live ?? liveConfig
      : scenario.configs?.replay ?? replayConfig,
    DSH_SESSION_ROOT: sessionsRoot,
    DSH_CWD: cwd,
    DSH_SNAPSHOT: mode,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    ...parentFixture === undefined ? {} : {
      DSH_SNAPSHOT_FILE: parentFixture,
      ...childFixtures.length > 0 ? { DSH_SNAPSHOT_CHILD_FILES: childFixtures.join(delimiter) } : {},
      ...hydrated.override === undefined ? {} : { DSH_SNAPSHOT_OVERRIDE: hydrated.override },
    },
    ...scenario.environment,
  }

  const harness = new DeepSeekHarness({
    launch: {
      command: launch.command,
      args: launch.args,
      cwd,
      env,
      requestTimeoutMs: 110_000,
    },
    cwd,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  try {
    const { result, notifications } = scenario.interrupt === undefined
      ? await runPromptDrive(harness, scenario, cwd)
      : await runInterruptDrive(harness, scenario, scenario.interrupt, cwd)
    await harness.close()
    const logs = await persistedLogs(sessionsRoot)
    const observedFiles = Object.fromEntries(await Promise.all(
      Object.keys(scenario.expectedFiles ?? {}).map(async (path): Promise<[string, string | MissingFile]> => [
        path,
        await readExpectedFile(join(cwd, path)),
      ]),
    ))
    return { result, notifications, logs, observedFiles, cwd }
  } finally {
    await harness.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Order logs parent-first, children by creation time (fixture layout order). */
function orderLogs(logs: PersistedLog[], scenario: SdkScenario): PersistedLog[] {
  const parents = logs.filter(log => typeof log.header.parentSession !== 'string')
  const children = logs.filter(log => typeof log.header.parentSession === 'string')
    .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
  expect(parents).toHaveLength(1)
  expect(children).toHaveLength(scenario.children)
  return [...parents, ...children]
}

function fixtureFiles(scenario: SdkScenario): string[] {
  const dir = join(snapshotsDir, scenario.name)
  return [
    join(dir, 'session.jsonl'),
    ...Array.from({ length: scenario.children }, (_, index) => join(dir, `session.${index + 1}.jsonl`)),
  ]
}

describe('TypeScript SDK snapshots over the jsonrpc runtime', () => {
  for (const scenario of SCENARIOS) {
    it(`replays ${scenario.name} through the SDK`, async () => {
      if (recording && scenario.interrupt !== undefined) {
        throw new Error(`${scenario.name} is authored against the replay hang entry; a live hang is not recordable`)
      }
      const scenarioDir = join(snapshotsDir, scenario.name)
      const notificationsExpectedPath = join(scenarioDir, 'notifications.expected.jsonl')
      const resultExpectedPath = join(scenarioDir, 'result.expected.json')

      const { result, notifications, logs, observedFiles, cwd } = await runScenario(scenario)
      const ordered = orderLogs(logs, scenario)
      const actualContext = contextOf(ordered, cwd)
      const files = fixtureFiles(scenario)

      if (recording) {
        // Fixtures carry tokenized request headers; llm-replay reads only
        // assistant output and tool traffic, so scrubbing keeps prompts and
        // schemas out of the corpus without affecting replay.
        await mkdir(scenarioDir, { recursive: true })
        const existing = await Promise.all(files.map(async file => existsSync(file) ? readFile(file, 'utf8') : ''))
        const fixtures = stabilizeFixtureMessageIds(
          ordered.map(log => scrubRequestHeaders(tokenizeSessionFixtureCwd(log.content))),
          existing,
        )
        await Promise.all(fixtures.map(async (fixture, index) => {
          const file = files[index]
          if (file === undefined) throw new Error(`no fixture path for persisted log ${index}`)
          await writeFile(file, fixture)
        }))
      }

      let expectedContents = await Promise.all(files.map(file => readFile(file, 'utf8')))

      if (refreshing) {
        const harvested = ordered.map((log): HarvestedLog => ({
          id: String(log.header.id),
          createdAt: Number(log.header.createdAt),
          ...typeof log.header.parentSession === 'string' ? { parentSession: log.header.parentSession } : {},
          content: log.content,
        }))
        const replacements = refreshFixtureReplacements(harvested, expectedContents)
        const refreshed = ordered.map((log, index) => {
          const existing = expectedContents[index]
          if (existing === undefined) throw new Error(`no fixture for persisted log ${index}`)
          return scrubRequestHeaders(tokenizeSessionFixtureCwd(
            stabilizeRefreshLog(log.content, existing, replacements, actualContext),
          ))
        })
        expectedContents = stabilizeFixtureMessageIds(refreshed, expectedContents)
        await Promise.all(expectedContents.map(async (stable, index) => {
          const file = files[index]
          if (file === undefined) throw new Error(`no fixture for persisted log ${index}`)
          await writeFile(file, stable)
        }))
      }

      for (const [index, expected] of expectedContents.entries()) {
        expect(scrubRequestHeaders(expected), `${scenario.name} session fixture ${index} carries request-header bulk`)
          .toBe(expected)
      }

      // Persisted transcripts match the committed fixtures.
      const expectedContext = contextOfContents(expectedContents)
      for (const [index, log] of ordered.entries()) {
        const expected = expectedContents[index]
        if (expected === undefined) throw new Error(`no fixture for persisted log ${index}`)
        expect(scrubRequestHeaders(normalizeSessionLog(log.content, actualContext)))
          .toBe(scrubRequestHeaders(normalizeSessionLog(expected, expectedContext)))
      }

      // The SDK-visible wire stream and turn result match their expected outputs.
      const normalizedNotifications = normalizeNotifications(notifications, actualContext)
      const normalizedResult = normalizeResult(result, actualContext)
      if (recording || refreshing) {
        await writeFile(notificationsExpectedPath, normalizedNotifications)
        await writeFile(resultExpectedPath, normalizedResult)
      }
      expect(normalizedNotifications).toBe(await readFile(notificationsExpectedPath, 'utf8'))
      expect(normalizedResult).toBe(await readFile(resultExpectedPath, 'utf8'))

      // Wire-shape invariants that must hold in every mode.
      expect(notifications.at(-1)).toMatchObject({
        method: 'session.status',
        params: { status: 'idle' },
      })
      expect(observedFiles).toEqual(scenario.expectedFiles ?? {})
      if (scenario.expectedTools !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledToolRequirements(parent)).toEqual(scenario.expectedTools)
      }
      if (scenario.expectedSystem !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledSystem(parent)).toBe(scenario.expectedSystem)
      }
      if (scenario.expectedToolDescriptions !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledToolDescriptions(parent)).toMatchObject(scenario.expectedToolDescriptions)
      }
      if (scenario.runtimeContext !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        const contexts = assembledRuntimeContexts(parent)
        if (scenario.runtimeContext === false) {
          expect(contexts).toEqual([])
        } else {
          expect(contexts).toHaveLength(1)
          const context = contexts[0] as string
          for (const clause of scenario.runtimeContext.includes) expect(context).toContain(clause)
          for (const clause of scenario.runtimeContext.excludes) expect(context).not.toContain(clause)
          const system = assembledSystem(parent)
          for (const clause of scenario.runtimeContext.includes) expect(system).not.toContain(clause)
        }
      }
      if (scenario.children > 0) {
        expect(notifications.some(n => n.method === 'subagent.started')).toBe(true)
        expect(notifications.some(n => n.method === 'subagent.finished')).toBe(true)
      }
    })
  }
})
