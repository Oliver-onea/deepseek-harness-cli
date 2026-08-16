/**
 * `/model` behavior: catalog derivation from the live adapter registry,
 * argument matching, selection application through `resolveCallConfig`, the
 * keyboard panel, and the command's degradation paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Component } from '@earendil-works/pi-tui'
import {
  applyModelSelection,
  findCandidate,
  modelCandidates,
  ModelPickerPanel,
  runModelCommand,
  type ModelCandidate,
  type ModelSelectionUi,
} from '../src/model-picker.ts'
import type { PanelHost } from '../src/questions.ts'
import { createPalette } from '../src/theme.ts'

const DOWN = '\x1b[B'
const UP = '\x1b[A'
const ENTER = '\r'
const ESCAPE = '\x1b'

/** The accepted request modalities an adapter states for one exact model. */
type Modalities = LlmModelInfo['inputModalities']

/** An adapter whose catalog and exact-model metadata the test scripts. */
class ScriptedAdapter extends LlmAdapter {
  constructor(
    private readonly models: readonly LlmModelInfo[] | Error,
    private readonly reasoning?: LlmModelReasoningInfo,
    private readonly exactError?: Error,
    private readonly modalities?: Modalities,
  ) {
    super()
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return this.models instanceof Error ? Promise.reject(this.models) : Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.exactError !== undefined) return Promise.reject(this.exactError)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
      ...this.modalities === undefined ? {} : { inputModalities: this.modalities },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Picker tests never enter provider streaming.
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

const CHAT: ModelCandidate = { provider: 'deepseek-official', model: 'deepseek-chat', name: 'DeepSeek Chat' }
const REASONER: ModelCandidate = { provider: 'deepseek-official', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
const OTHER: ModelCandidate = { provider: 'other', model: 'other-model', name: 'Other' }
const CANDIDATES: readonly ModelCandidate[] = [CHAT, REASONER, OTHER]

/** A plain text block, the non-image content the guard admits freely. */
const TEXT: ContentBlock = { type: 'text', text: 'plain' }

/** A durable image reference, the block the guard exists to protect. */
const IMAGE: ContentBlock = {
  type: 'image',
  attachment: {
    attachmentId: AttachmentId('attachment-1'),
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  },
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** A registry over scripted adapters, the composition the command reads. */
async function llmWith(adapters: Record<string, ScriptedAdapter>): Promise<LlmRuntime> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  for (const [provider, adapter] of Object.entries(adapters)) {
    ctx.llm.registerAdapter([provider], adapter)
  }
  return ctx.llm
}

const catalogAdapter = (models: readonly LlmModelInfo[], reasoning: LlmModelReasoningInfo = REASONING): ScriptedAdapter =>
  new ScriptedAdapter(models, reasoning)

describe('modelCandidates', () => {
  it('lists every advertised route in registration order, with sanitized names', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider: 'deepseek-official', id: 'evil', name: 're\x1b]0;hijack\x07paint' },
      ]),
      empty: catalogAdapter([]),
    })
    const catalog = await modelCandidates(llm)
    expect(catalog.candidates).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek-official', model: 'evil', name: 're\\x1b]0;hijack\\x07paint' },
    ])
    expect(catalog.failures).toEqual([])
  })

  it('carries a failed provider as a sanitized failure without failing the sound ones', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
      broken: new ScriptedAdapter(new Error('catalog \x1b]0;x\x07offline')),
    })
    const catalog = await modelCandidates(llm)
    expect(catalog.candidates.map(candidate => candidate.model)).toEqual(['deepseek-chat'])
    expect(catalog.failures).toEqual(['broken: catalog \\x1b]0;x\\x07offline'])
  })

  it('renders a non-Error listing rejection without trusting its coercion', async () => {
    const rejecting = new ScriptedAdapter([])
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    rejecting.listModels = () => Promise.reject('catalog gone')
    const llm = await llmWith({ broken: rejecting })
    const catalog = await modelCandidates(llm)
    expect(catalog.failures).toEqual(['broken: catalog gone'])
  })
})

describe('findCandidate', () => {
  it('matches a unique bare model id', () => {
    expect(findCandidate(CANDIDATES, ' deepseek-reasoner ')).toEqual({ kind: 'candidate', candidate: REASONER })
  })

  it('matches an explicit provider/model route', () => {
    expect(findCandidate(CANDIDATES, 'other/other-model')).toEqual({ kind: 'candidate', candidate: OTHER })
  })

  it('rejects an explicit route no adapter advertises', () => {
    expect(findCandidate(CANDIDATES, 'other/deepseek-chat')).toBeUndefined()
    expect(findCandidate(CANDIDATES, 'nope')).toBeUndefined()
    expect(findCandidate(CANDIDATES, '  ')).toBeUndefined()
  })

  it('names the providers when a bare id is ambiguous', () => {
    const shared = [
      { provider: 'a', model: 'same', name: 'Same' },
      { provider: 'b', model: 'same', name: 'Same' },
      { provider: 'a', model: 'same', name: 'Same' },
    ]
    expect(findCandidate(shared, 'same')).toEqual({ kind: 'ambiguous', model: 'same', providers: ['a', 'b'] })
  })
})

describe('applyModelSelection', () => {
  it('validates the route, materializes the default effort, and installs the selection', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT)).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    expect(selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
  })

  it('leaves the previous selection in place when validation rejects', async () => {
    const llm = await llmWith({ 'deepseek-official': new ScriptedAdapter([], undefined, new Error('metadata offline')) })
    const previous = { provider: 'p', model: 'm' }
    const selection: ModelSelectionRef = { current: previous, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT)).rejects.toThrow('metadata offline')
    expect(selection.current).toBe(previous)
  })

  it('installs no effort when the adapter advertises none', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT)).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
  })

  it('admits a text-only model when nothing carries an image', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        undefined,
        undefined,
        ['text'],
      ),
    })
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT, {
      pending: [{ content: [TEXT] }],
      logged: [{ content: [TEXT] }],
    })).resolves.toMatchObject({ model: 'deepseek-chat' })
  })

  it('rejects a text-only model when the logged surface carries an image', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        undefined,
        undefined,
        ['text'],
      ),
    })
    const previous = { provider: 'p', model: 'm' }
    const selection: ModelSelectionRef = { current: previous, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT, {
      pending: [],
      logged: [{ content: [IMAGE] }],
    })).rejects.toThrow('does not accept image input')
    expect(selection.current).toBe(previous)
  })

  it('rejects a text-only model when only a queued message carries an image', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        undefined,
        undefined,
        ['text'],
      ),
    })
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT, {
      pending: [{ content: [IMAGE] }],
      logged: [],
    })).rejects.toThrow('does not accept image input')
    expect(selection.current).toBeUndefined()
  })

  it('admits an image-capable model and one that states no modalities', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        undefined,
        undefined,
        ['text', 'image'],
      ),
      quiet: new ScriptedAdapter([{ provider: 'quiet', id: 'deepseek-chat', name: 'Quiet' }]),
    })
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    await expect(applyModelSelection(llm, selection, CHAT, {
      pending: [],
      logged: [{ content: [IMAGE] }],
    })).resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await expect(applyModelSelection(llm, selection, { provider: 'quiet', model: 'deepseek-chat', name: 'Quiet' }, {
      pending: [],
      logged: [{ content: [IMAGE] }],
    })).resolves.toMatchObject({ provider: 'quiet' })
  })
})

/** A recording host: the panels the command presented, and their lifetimes. */
function fakeHost(): PanelHost & { panels: Component[]; closed: Component[] } {
  const panels: Component[] = []
  const closed: Component[] = []
  return {
    panels,
    closed,
    present(panel: Component): () => void {
      panels.push(panel)
      return () => { closed.push(panel) }
    },
    requestRender: () => {},
  }
}

/** Let the command's catalog read settle before driving the panel it opened. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** One panel under observation, the way a test drives it. */
function picker(candidates: readonly ModelCandidate[], over: { visible?: number; failures?: readonly string[] } = {}) {
  const settled: (ModelCandidate | undefined)[] = []
  let changes = 0
  const panel = new ModelPickerPanel(
    {
      catalog: { candidates, failures: over.failures ?? [] },
      current: { provider: CHAT.provider, model: CHAT.model },
      palette: createPalette(false),
      visible: over.visible ?? 8,
    },
    (candidate) => { settled.push(candidate) },
    () => { changes += 1 },
  )
  return { panel, settled, changes: () => changes }
}

describe('ModelPickerPanel', () => {
  it('draws numbered routes with the current one marked and failures listed', () => {
    const { panel } = picker(CANDIDATES, { failures: ['broken: offline'] })
    panel.invalidate()
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('Model')
    expect(drawn).toContain('1. ● deepseek-official/deepseek-chat — DeepSeek Chat')
    expect(drawn).toContain('2.   deepseek-official/deepseek-reasoner — DeepSeek Reasoner')
    expect(drawn).toContain('3.   other/other-model — Other')
    expect(drawn).toContain('! broken: offline')
    expect(drawn).toContain('↑↓ move')
    expect(drawn).toContain('enter apply')
    expect(drawn).toContain('esc cancel')
  })

  it('leaves rows past the number-key reach unnumbered', () => {
    const many: ModelCandidate[] = Array.from({ length: 10 }, (_unused, index) => ({
      provider: 'p',
      model: `model-${String(index)}`,
      name: `Model ${String(index)}`,
    }))
    const { panel } = picker(many, { visible: 10 })
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('9.   p/model-8')
    expect(drawn).not.toContain('10.')
    expect(drawn).toContain('p/model-9')
  })

  it('bounds the drawn rows to the visible window and names the overflow', () => {
    const { panel } = picker(CANDIDATES, { visible: 2 })
    const drawn = panel.render(80)
    expect(drawn.filter(line => line.includes('deepseek-'))).toHaveLength(2)
    expect(drawn).toContain('… 1 more')
    panel.handleInput(DOWN)
    panel.handleInput(DOWN)
    const scrolled = panel.render(80).join('\n')
    expect(scrolled).toContain('other/other-model')
    expect(scrolled).toContain('2.   deepseek-official/deepseek-reasoner')
    expect(scrolled).not.toContain('deepseek-chat')
  })

  it('applies the cursor row on enter and settles exactly once', () => {
    const { panel, settled } = picker(CANDIDATES)
    panel.handleInput(DOWN)
    panel.handleInput(ENTER)
    expect(settled).toEqual([REASONER])
    panel.handleInput(ENTER)
    panel.handleInput(ESCAPE)
    expect(settled).toHaveLength(1)
  })

  it('moves with the arrows and applies a numbered row directly', () => {
    const { panel, settled, changes } = picker(CANDIDATES)
    panel.handleInput(UP)
    expect(changes()).toBe(1)
    expect(settled).toEqual([])
    panel.handleInput(ENTER)
    expect(settled).toEqual([OTHER])
    const direct = picker(CANDIDATES)
    direct.panel.handleInput('2')
    expect(direct.settled).toEqual([REASONER])
  })

  it('dismisses on escape without applying anything', () => {
    const { panel, settled } = picker(CANDIDATES)
    panel.handleInput(ESCAPE)
    expect(settled).toEqual([undefined])
  })

  it('ignores keys that select nothing', () => {
    const { panel, settled, changes } = picker(CANDIDATES)
    panel.handleInput('0')
    panel.handleInput('9')
    panel.handleInput('x')
    expect(settled).toEqual([])
    expect(changes()).toBe(0)
  })

  it('offers no movement for a single route and keeps the controls honest', () => {
    const solo = picker([CHAT])
    solo.panel.handleInput(DOWN)
    expect(solo.changes()).toBe(0)
    const drawn = solo.panel.render(80).join('\n')
    expect(drawn).not.toContain('↑↓ move')
    expect(drawn).toContain('enter apply')
  })

  it('draws the same layout with and without color', () => {
    const draw = (color: boolean): string => {
      const panel = new ModelPickerPanel(
        { catalog: { candidates: CANDIDATES, failures: [] }, current: undefined, palette: createPalette(color), visible: 8 },
        () => {},
        () => {},
      )
      return panel.render(80).join('\n').replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/gu, '')
    }
    expect(draw(false)).toBe(draw(true))
  })
})

/** The command wiring over a scripted registry, ready to override. */
async function uiFor(over: Partial<ModelSelectionUi> = {}): Promise<ModelSelectionUi> {
  return {
    llm: await llmWith({
      'deepseek-official': catalogAdapter([
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]),
    }),
    selection: { current: { provider: 'deepseek-official', model: 'deepseek-chat' }, assembled: undefined },
    host: fakeHost(),
    palette: createPalette(false),
    rows: () => 30,
    maxVisible: 8,
    onApplied: vi.fn(),
    ...over,
  }
}

describe('runModelCommand', () => {
  it('fails loud when the composition mounts no llm service', async () => {
    const ui = await uiFor({ llm: undefined })
    await expect(runModelCommand(ui, 'deepseek-chat')).resolves.toEqual({
      kind: 'error',
      text: 'no model directory is available: this composition mounts no llm service',
    })
  })

  it('selects a unique model id directly and reports the applied effort', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, ' deepseek-reasoner ')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high)',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    expect(ui.onApplied).toHaveBeenCalledWith('deepseek-official', 'deepseek-reasoner')
  })

  it('refuses an unknown id, naming what was asked for and what is available', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, 'gpt-neo')).resolves.toEqual({
      kind: 'error',
      text: 'unknown model "gpt-neo"; available: deepseek-official/deepseek-chat, deepseek-official/deepseek-reasoner',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('refuses an ambiguous bare id by naming the providers', async () => {
    const llm = await llmWith({
      a: catalogAdapter([{ provider: 'a', id: 'same', name: 'Same' }]),
      b: catalogAdapter([{ provider: 'b', id: 'same', name: 'Same' }]),
    })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, 'same')).resolves.toEqual({
      kind: 'error',
      text: 'model "same" is served by providers a, b; name it as provider/model',
    })
  })

  it('keeps the previous route when validation rejects the switch', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        undefined,
        new Error('metadata offline'),
      ),
    })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, 'deepseek-chat')).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-chat: metadata offline',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(ui.onApplied).not.toHaveBeenCalled()
  })

  it('reports a validation rejection that is not an Error without trusting its coercion', async () => {
    const rejecting = new ScriptedAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }])
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    rejecting.resolveModel = () => Promise.reject('route gone')
    const llm = await llmWith({ 'deepseek-official': rejecting })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, 'deepseek-chat')).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-chat: route gone',
    })
  })

  it('reports a switch without an effort when the adapter advertises none', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, 'deepseek-chat')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-chat',
    })
  })

  it('opens the picker with no argument and settles with a picked route', async () => {
    const host = fakeHost()
    const ui = await uiFor({ host })
    const pending = runModelCommand(ui, '')
    await settle()
    const panel = host.panels[0] as ModelPickerPanel
    expect(panel).toBeDefined()
    expect(panel.render(80).join('\n')).toContain('● deepseek-official/deepseek-chat')
    panel.handleInput('2')
    await expect(pending).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high)',
    })
    expect(ui.selection.current?.model).toBe('deepseek-reasoner')
    expect(host.closed).toEqual([panel])
  })

  it('keeps the route when the picker is dismissed', async () => {
    const host = fakeHost()
    const ui = await uiFor({ host })
    const pending = runModelCommand(ui, '  ')
    await settle()
    ;(host.panels[0] as ModelPickerPanel).handleInput(ESCAPE)
    await expect(pending).resolves.toEqual({ kind: 'success' })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(ui.onApplied).not.toHaveBeenCalled()
  })

  it('reports a picker pick that validation refuses', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [
          { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
        undefined,
        new Error('metadata offline'),
      ),
    })
    const host = fakeHost()
    const ui = await uiFor({ host, llm })
    const pending = runModelCommand(ui, '')
    await settle()
    const panel = host.panels[0] as ModelPickerPanel
    panel.handleInput(DOWN)
    panel.handleInput(UP)
    panel.handleInput(ENTER)
    await expect(pending).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-official/deepseek-chat: metadata offline',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('reports a picker pick rejected with a non-Error value', async () => {
    const rejecting = new ScriptedAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }])
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    rejecting.resolveModel = () => Promise.reject('route gone')
    const llm = await llmWith({ 'deepseek-official': rejecting })
    const host = fakeHost()
    const ui = await uiFor({ host, llm })
    const pending = runModelCommand(ui, '')
    await settle()
    ;(host.panels[0] as ModelPickerPanel).handleInput(ENTER)
    await expect(pending).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-official/deepseek-chat: route gone',
    })
  })

  it('refuses the picker on a terminal too small for one candidate row', async () => {
    const host = fakeHost()
    const ui = await uiFor({ host, rows: () => 5 })
    await expect(runModelCommand(ui, '')).resolves.toEqual({
      kind: 'error',
      text: 'the terminal is too small for the model picker; switch with /model <provider>/<model>',
    })
    expect(host.panels).toEqual([])
  })

  it('names the catalog failures when nothing is selectable', async () => {
    const llm = await llmWith({ broken: new ScriptedAdapter(new Error('offline')) })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, '')).resolves.toEqual({
      kind: 'error',
      text: 'no models are available; available: nothing; failed to list broken: offline',
    })
    await expect(runModelCommand(ui, 'x')).resolves.toEqual({
      kind: 'error',
      text: 'unknown model "x"; available: nothing; failed to list broken: offline',
    })
  })

  it('persists a pick as the deployment default after installing it', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high)',
    })
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      reasoningEffort: ReasoningEffortId('high'),
    })
  })

  it('keeps a pick whose default-save rejects, reporting the failure as a warning', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('settings unwritable'))
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high); not saved as the default: settings unwritable',
    })
    expect(ui.selection.current).toMatchObject({ model: 'deepseek-reasoner' })
    expect(ui.onApplied).toHaveBeenCalledWith('deepseek-official', 'deepseek-reasoner')
  })

  it('stringifies a default-save rejection that is not an Error', async () => {
    const persist = vi.fn().mockImplementation(() => Promise.reject('disk gone' as never))
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high); not saved as the default: disk gone',
    })
  })

  it('switches without persistence when the composition mounts no default-model service', async () => {
    const ui = await uiFor({ persist: undefined })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high)',
    })
  })

  it('reads the image surface at pick time and refuses an image-incapable route', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [
          { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
        undefined,
        undefined,
        ['text'],
      ),
    })
    const imageSurface = vi.fn(() => ({ pending: [], logged: [{ content: [IMAGE] }] }))
    const ui = await uiFor({ llm, imageSurface })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-reasoner: model "deepseek-reasoner" does not accept image input, but this session already contains images; select an image-capable model',
    })
    expect(imageSurface).toHaveBeenCalledExactlyOnceWith()
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(ui.onApplied).not.toHaveBeenCalled()
  })

  it('admits an image-carrying session onto an image-capable route', async () => {
    const llm = await llmWith({
      'deepseek-official': new ScriptedAdapter(
        [
          { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
        undefined,
        undefined,
        ['text', 'image'],
      ),
    })
    const ui = await uiFor({ llm, imageSurface: () => ({ pending: [{ content: [IMAGE] }], logged: [] }) })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner',
    })
    expect(ui.selection.current).toMatchObject({ model: 'deepseek-reasoner' })
  })
})
