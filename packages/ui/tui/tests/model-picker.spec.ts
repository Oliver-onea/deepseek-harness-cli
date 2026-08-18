/**
 * `/model` behavior: catalog derivation from the live adapter registry,
 * argument matching, effort selection and its pick-time validation, selection
 * application through `resolveCallConfig`, the keyboard panel and its effort
 * tier, and the command's degradation paths.
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
  effortRequestFor,
  findCandidate,
  markedEffort,
  modelCandidates,
  ModelPickerPanel,
  runModelCommand,
  type CandidateReasoning,
  type EffortRequest,
  type ModelCandidate,
  type ModelPick,
  type ModelSelectionUi,
} from '../src/model-picker.ts'
import type { PanelHost } from '../src/questions.ts'
import { createPalette } from '../src/theme.ts'

const DOWN = '\x1b[B'
const UP = '\x1b[A'
const RIGHT = '\x1b[C'
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

/**
 * An adapter whose exact-route resolution succeeds once — for the catalog
 * read — and then rejects with a non-Error value, so a pick that validated
 * its route through the catalog still meets a rejection at apply time.
 */
class SecondCallRejectingAdapter extends ScriptedAdapter {
  private calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.calls += 1
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    if (this.calls > 1) return Promise.reject('route gone')
    return super.resolveModel(provider, model)
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

/** The candidate-side mirror of {@link REASONING} the catalog read produces. */
const REASONING_DECLARED: CandidateReasoning = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

const CHAT: ModelCandidate = {
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  name: 'DeepSeek Chat',
  reasoning: REASONING_DECLARED,
}
const REASONER: ModelCandidate = {
  provider: 'deepseek-official',
  model: 'deepseek-reasoner',
  name: 'DeepSeek Reasoner',
  reasoning: REASONING_DECLARED,
}
const OTHER: ModelCandidate = { provider: 'other', model: 'other-model', name: 'Other', reasoning: undefined }
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
  it('lists every advertised route with its adapter-declared efforts, names sanitized', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider: 'deepseek-official', id: 'evil', name: 're\x1b]0;hijack\x07paint' },
      ]),
      empty: catalogAdapter([]),
    })
    const catalog = await modelCandidates(llm)
    expect(catalog.candidates).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: REASONING_DECLARED },
      {
        provider: 'deepseek-official',
        model: 'evil',
        name: 're\\x1b]0;hijack\\x07paint',
        reasoning: REASONING_DECLARED,
      },
    ])
    expect(catalog.failures).toEqual([])
  })

  it('sanitizes effort names the adapter declares', async () => {
    const llm = await llmWith({
      sneaky: catalogAdapter(
        [{ provider: 'sneaky', id: 'one', name: 'One' }],
        {
          efforts: [{ id: ReasoningEffortId('boom'), name: 're\x1b]0;hijack\x07paint' }],
          defaultEffort: ReasoningEffortId('boom'),
        },
      ),
    })
    const catalog = await modelCandidates(llm)
    expect(catalog.candidates[0]?.reasoning).toEqual({
      efforts: [{ id: ReasoningEffortId('boom'), name: 're\\x1b]0;hijack\\x07paint' }],
      defaultEffort: ReasoningEffortId('boom'),
    })
  })

  it('leaves a route without declared efforts offering none', async () => {
    const llm = await llmWith({
      plain: new ScriptedAdapter([{ provider: 'plain', id: 'one', name: 'One' }]),
    })
    const catalog = await modelCandidates(llm)
    expect(catalog.candidates).toEqual([
      { provider: 'plain', model: 'one', name: 'One', reasoning: undefined },
    ])
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

  it('fails a provider whose exact-route resolution rejects, as the web catalog does', async () => {
    const llm = await llmWith({
      broken: new ScriptedAdapter([{ provider: 'broken', id: 'one', name: 'One' }], undefined, new Error('metadata offline')),
      plain: catalogAdapter([{ provider: 'plain', id: 'two', name: 'Two' }]),
    })
    const catalog = await modelCandidates(llm)
    expect(catalog.candidates.map(candidate => candidate.model)).toEqual(['two'])
    expect(catalog.failures).toEqual(['broken: metadata offline'])
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
      { provider: 'a', model: 'same', name: 'Same', reasoning: undefined },
      { provider: 'b', model: 'same', name: 'Same', reasoning: undefined },
      { provider: 'a', model: 'same', name: 'Same', reasoning: undefined },
    ]
    expect(findCandidate(shared, 'same')).toEqual({ kind: 'ambiguous', model: 'same', providers: ['a', 'b'] })
  })
})

describe('effortRequestFor', () => {
  it('resolves an advertised effort id', () => {
    expect(effortRequestFor(CHAT, 'off')).toEqual<EffortRequest>({ kind: 'effort', id: ReasoningEffortId('off') })
  })

  it('resolves the default sentinel', () => {
    expect(effortRequestFor(CHAT, 'default')).toEqual<EffortRequest>({ kind: 'default' })
  })

  it('lets an advertised id literally named default outrank the sentinel', () => {
    const candidate: ModelCandidate = {
      ...CHAT,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('default'), name: 'Default' }],
        defaultEffort: ReasoningEffortId('default'),
      },
    }
    expect(effortRequestFor(candidate, 'default')).toEqual<EffortRequest>({
      kind: 'effort',
      id: ReasoningEffortId('default'),
    })
  })

  it('names what is available when the argument matches no effort', () => {
    expect(() => effortRequestFor(CHAT, 'turbo')).toThrow(
      'unknown effort "turbo" for deepseek-official/deepseek-chat; available: default, off, high',
    )
  })

  it('refuses any effort argument for a route that offers none', () => {
    expect(() => effortRequestFor(OTHER, 'high')).toThrow('other/other-model offers no reasoning efforts')
  })
})

describe('markedEffort', () => {
  it('marks the in-force effort of the current route, else the declared default', () => {
    expect(markedEffort(CHAT, { provider: CHAT.provider, model: CHAT.model, reasoningEffort: ReasoningEffortId('off') }))
      .toBe('off')
    expect(markedEffort(CHAT, { provider: 'other', model: 'else' })).toBe('high')
    expect(markedEffort(CHAT, undefined)).toBe('high')
  })

  it('marks nothing for a route that offers no efforts', () => {
    expect(markedEffort(OTHER, { provider: 'other', model: 'other-model' })).toBeUndefined()
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

  it('keeps the in-force effort when the same route is picked again', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const selection: ModelSelectionRef = {
      current: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: ReasoningEffortId('off') },
      assembled: undefined,
    }
    await expect(applyModelSelection(llm, selection, CHAT)).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'off',
    })
  })

  it('keeps an absent effort absent when the same route is picked again', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const selection: ModelSelectionRef = {
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
      assembled: undefined,
    }
    await expect(applyModelSelection(llm, selection, CHAT)).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
  })

  it('replaces the in-force effort with the new route default on a route switch', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]),
      other: new ScriptedAdapter([{ provider: 'other', id: 'other-model', name: 'Other' }]),
    })
    const selection: ModelSelectionRef = {
      current: { provider: 'other', model: 'other-model', reasoningEffort: ReasoningEffortId('max') },
      assembled: undefined,
    }
    await expect(applyModelSelection(llm, selection, CHAT)).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
  })

  it('installs an explicitly picked effort', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    await expect(
      applyModelSelection(llm, selection, CHAT, undefined, { kind: 'effort', id: ReasoningEffortId('off') }),
    ).resolves.toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'off' })
  })

  it('installs no effort for a default request, dropping an in-force effort on the same route', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const selection: ModelSelectionRef = {
      current: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: ReasoningEffortId('off') },
      assembled: undefined,
    }
    await expect(
      applyModelSelection(llm, selection, CHAT, undefined, { kind: 'default' }),
    ).resolves.toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(selection.current?.reasoningEffort).toBeUndefined()
  })

  it('rejects an effort the route does not advertise, keeping the previous selection', async () => {
    const llm = await llmWith({
      'deepseek-official': catalogAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    })
    const previous = { provider: 'p', model: 'm' }
    const selection: ModelSelectionRef = { current: previous, assembled: undefined }
    await expect(
      applyModelSelection(llm, selection, CHAT, undefined, { kind: 'effort', id: ReasoningEffortId('turbo') }),
    ).rejects.toThrow('does not support reasoning effort "turbo"')
    expect(selection.current).toBe(previous)
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
    await expect(applyModelSelection(llm, selection, { ...CHAT, reasoning: undefined })).resolves.toEqual({
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
    await expect(applyModelSelection(llm, selection, { ...CHAT, reasoning: undefined }, {
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
    await expect(applyModelSelection(llm, selection, { ...CHAT, reasoning: undefined }, {
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
    await expect(applyModelSelection(llm, selection, { ...CHAT, reasoning: undefined }, {
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
    await expect(applyModelSelection(llm, selection, { ...CHAT, reasoning: undefined }, {
      pending: [],
      logged: [{ content: [IMAGE] }],
    })).resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await expect(applyModelSelection(llm, selection, {
      provider: 'quiet',
      model: 'deepseek-chat',
      name: 'Quiet',
      reasoning: undefined,
    }, {
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
function picker(
  candidates: readonly ModelCandidate[],
  over: {
    visible?: number
    failures?: readonly string[]
    current?: ModelSelectionUi['selection']['current']
  } = {},
) {
  const settled: (ModelPick | undefined)[] = []
  let changes = 0
  const panel = new ModelPickerPanel(
    {
      catalog: { candidates, failures: over.failures ?? [] },
      current: over.current ?? { provider: CHAT.provider, model: CHAT.model },
      palette: createPalette(false),
      visible: over.visible ?? 8,
    },
    (pick) => { settled.push(pick) },
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
    expect(drawn).toContain('→ effort')
    expect(drawn).toContain('enter apply')
    expect(drawn).toContain('esc cancel')
  })

  it('names no effort drill while the cursor route offers none', () => {
    const { panel } = picker(CANDIDATES)
    panel.handleInput(DOWN)
    panel.handleInput(DOWN)
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('other/other-model')
    expect(drawn).not.toContain('→ effort')
  })

  it('leaves rows past the number-key reach unnumbered', () => {
    const many: ModelCandidate[] = Array.from({ length: 10 }, (_unused, index) => ({
      provider: 'p',
      model: `model-${String(index)}`,
      name: `Model ${String(index)}`,
      reasoning: undefined,
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
    expect(settled).toEqual([{ candidate: REASONER }])
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
    expect(settled).toEqual([{ candidate: OTHER }])
    const direct = picker(CANDIDATES)
    direct.panel.handleInput('2')
    expect(direct.settled).toEqual([{ candidate: REASONER }])
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

  it('drills into the effort tier for a route that advertises efforts', () => {
    const { panel, settled } = picker(CANDIDATES)
    panel.handleInput(RIGHT)
    expect(settled).toEqual([])
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('Effort')
    expect(drawn).toContain(' deepseek-official/deepseek-chat')
    expect(drawn).toContain("1.   default — the model's default effort")
    expect(drawn).toContain('2.   off — Off')
    expect(drawn).toContain('3. ● high — High')
    expect(drawn).toContain('enter apply')
    expect(drawn).toContain('esc back')
    expect(drawn).not.toContain('esc cancel')
  })

  it('marks the in-force effort of the current route in its tier', () => {
    const { panel } = picker(CANDIDATES, {
      current: { provider: CHAT.provider, model: CHAT.model, reasoningEffort: ReasoningEffortId('off') },
    })
    panel.handleInput(RIGHT)
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('2. ● off — Off')
    expect(drawn).toContain('3.   high — High')
  })

  it('drills no tier for a route without efforts and applies it directly', () => {
    const { panel, settled } = picker(CANDIDATES)
    panel.handleInput(DOWN)
    panel.handleInput(DOWN)
    panel.handleInput(RIGHT)
    expect(settled).toEqual([])
    expect(panel.render(80).join('\n')).toContain('other/other-model')
    panel.handleInput(ENTER)
    expect(settled).toEqual([{ candidate: OTHER }])
  })

  it('returns to the model list from the tier on escape, cursor intact and usable', () => {
    const { panel, settled, changes } = picker(CANDIDATES)
    panel.handleInput(DOWN)
    panel.handleInput(RIGHT)
    expect(panel.render(80).join('\n')).toContain('Effort')
    panel.handleInput(ESCAPE)
    expect(settled).toEqual([])
    expect(changes()).toBeGreaterThan(0)
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('Model')
    expect(drawn).toContain('deepseek-official/deepseek-reasoner')
    panel.handleInput(ENTER)
    expect(settled).toEqual([{ candidate: REASONER }])
  })

  it('applies the marked row on enter in the tier and settles exactly once', () => {
    const { panel, settled } = picker(CANDIDATES)
    panel.handleInput(RIGHT)
    panel.handleInput(ENTER)
    expect(settled).toEqual([{ candidate: CHAT, effort: { kind: 'effort', id: ReasoningEffortId('high') } }])
    panel.handleInput(ENTER)
    panel.handleInput(ESCAPE)
    expect(settled).toHaveLength(1)
  })

  it('moves in the tier and applies a numbered row directly', () => {
    const { panel, settled } = picker(CANDIDATES)
    panel.handleInput(RIGHT)
    panel.handleInput(DOWN)
    panel.handleInput(DOWN)
    panel.handleInput(UP)
    expect(settled).toEqual([])
    panel.handleInput('1')
    expect(settled).toEqual([{ candidate: CHAT, effort: { kind: 'default' } }])
  })

  it('bounds the tier rows to the visible window and names the overflow', () => {
    const { panel } = picker(CANDIDATES, { visible: 2 })
    panel.handleInput(RIGHT)
    const drawn = panel.render(80)
    expect(drawn.filter(line => line.includes('—'))).toHaveLength(2)
    expect(drawn).toContain('… 1 more')
  })

  it('leaves tier rows past the number-key reach unnumbered', () => {
    const many: CandidateReasoning = {
      efforts: Array.from({ length: 12 }, (_unused, index) => ({
        id: ReasoningEffortId(`e-${String(index)}`),
        name: `E ${String(index)}`,
      })),
      defaultEffort: ReasoningEffortId('e-0'),
    }
    const { panel } = picker([{ ...CHAT, reasoning: many }], { visible: 14 })
    panel.handleInput(RIGHT)
    const drawn = panel.render(80).join('\n')
    expect(drawn).toContain('9.   e-7')
    expect(drawn).not.toContain('10.')
    expect(drawn).toContain('e-11')
  })

  it('ignores keys that select nothing in the tier', () => {
    const { panel, settled, changes } = picker(CANDIDATES)
    panel.handleInput(RIGHT)
    panel.handleInput('0')
    panel.handleInput('9')
    panel.handleInput('x')
    expect(settled).toEqual([])
    expect(changes()).toBe(1)
  })

  it('draws the same list and tier layout with and without color', () => {
    const draw = (color: boolean): string => {
      const panel = new ModelPickerPanel(
        { catalog: { candidates: CANDIDATES, failures: [] }, current: undefined, palette: createPalette(color), visible: 8 },
        () => {},
        () => {},
      )
      const list = panel.render(80).join('\n')
      panel.handleInput(RIGHT)
      const tier = panel.render(80).join('\n')
      return `${list}\n${tier}`.replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/gu, '')
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
      other: new ScriptedAdapter([{ provider: 'other', id: 'other-model', name: 'Other' }]),
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
      text: 'unknown model "gpt-neo"; available: deepseek-official/deepseek-chat, deepseek-official/deepseek-reasoner, other/other-model',
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

  it('refuses more arguments than a route and an effort', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, 'deepseek-chat off now')).resolves.toEqual({
      kind: 'error',
      text: 'usage: /model <provider/model> [default | <effort>]',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('reports an exact-route resolution failure as a catalog failure, keeping the selection', async () => {
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
      text: 'unknown model "deepseek-chat"; available: nothing; failed to list deepseek-official: metadata offline',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(ui.onApplied).not.toHaveBeenCalled()
  })

  it('reports a rejection that surfaces only at apply time, without trusting a non-Error coercion', async () => {
    const llm = await llmWith({
      'deepseek-official': new SecondCallRejectingAdapter([
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      ]),
    })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, 'deepseek-chat')).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-chat: route gone',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('reports a picker pick that rejects only at apply time, without trusting a non-Error coercion', async () => {
    const llm = await llmWith({
      'deepseek-official': new SecondCallRejectingAdapter([
        { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      ]),
    })
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

  it('renders a non-Error exact-route rejection as a catalog failure without trusting its coercion', async () => {
    const rejecting = new ScriptedAdapter([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }])
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    rejecting.resolveModel = () => Promise.reject('route gone')
    const llm = await llmWith({ 'deepseek-official': rejecting })
    const catalog = await modelCandidates(llm)
    expect(catalog.failures).toEqual(['deepseek-official: route gone'])
  })

  it('reports a switch without an effort when the adapter advertises none', async () => {
    const llm = await llmWith({
      other: new ScriptedAdapter([{ provider: 'other', id: 'other-model', name: 'Other' }]),
    })
    const ui = await uiFor({ llm })
    await expect(runModelCommand(ui, 'other-model')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to other/other-model',
    })
  })

  it('pins an advertised effort by argument', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner off')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off)',
    })
    expect(ui.selection.current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      reasoningEffort: 'off',
    })
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      reasoningEffort: ReasoningEffortId('off'),
    })
  })

  it('clears the effort for the default argument and persists the complete section without one', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner default')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning high)',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
    })
  })

  it('refuses an unknown effort at pick time, naming what is available and keeping the selection', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, 'deepseek-reasoner turbo')).resolves.toEqual({
      kind: 'error',
      text: 'unknown effort "turbo" for deepseek-official/deepseek-reasoner; available: default, off, high',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(ui.onApplied).not.toHaveBeenCalled()
  })

  it('refuses any effort argument for a route that offers none', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, 'other-model high')).resolves.toEqual({
      kind: 'error',
      text: 'other/other-model offers no reasoning efforts',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('replaces an effort pick with the new route default on a model pick, naming the transition', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner off')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off)',
    })
    await expect(runModelCommand(ui, 'deepseek-chat')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-chat (reasoning high, was off)',
    })
    expect(ui.selection.current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    expect(persist).toHaveBeenLastCalledWith({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: ReasoningEffortId('high'),
    })
  })

  it('keeps an effort pick when the same route is picked again bare', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, 'deepseek-reasoner off')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off)',
    })
    await expect(runModelCommand(ui, 'deepseek-reasoner')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off)',
    })
    expect(ui.selection.current?.reasoningEffort).toBe('off')
  })

  it('names the drop when a model pick lands on a route that offers no efforts', async () => {
    const ui = await uiFor()
    await expect(runModelCommand(ui, 'deepseek-reasoner off')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off)',
    })
    await expect(runModelCommand(ui, 'other-model')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to other/other-model (no reasoning effort; was off)',
    })
    expect(ui.selection.current).toEqual({ provider: 'other', model: 'other-model' })
  })

  it('keeps a rejected default-save as a warning on an effort pick', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('settings unwritable'))
    const ui = await uiFor({ persist })
    await expect(runModelCommand(ui, 'deepseek-reasoner off')).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off); not saved as the default: settings unwritable',
    })
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      reasoningEffort: ReasoningEffortId('off'),
    })
    expect(ui.selection.current).toMatchObject({ model: 'deepseek-reasoner', reasoningEffort: 'off' })
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

  it('applies an effort the picker tier picked', async () => {
    const host = fakeHost()
    const ui = await uiFor({ host })
    const pending = runModelCommand(ui, '')
    await settle()
    const panel = host.panels[0] as ModelPickerPanel
    panel.handleInput(DOWN)
    panel.handleInput(RIGHT)
    expect(panel.render(80).join('\n')).toContain('Effort')
    panel.handleInput('2')
    await expect(pending).resolves.toEqual({
      kind: 'success',
      text: 'Model switched to deepseek-official/deepseek-reasoner (reasoning off)',
    })
    expect(ui.selection.current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      reasoningEffort: 'off',
    })
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
        undefined,
        ['text'],
      ),
    })
    const host = fakeHost()
    const ui = await uiFor({ host, llm, imageSurface: () => ({ pending: [], logged: [{ content: [IMAGE] }] }) })
    const pending = runModelCommand(ui, '')
    await settle()
    const panel = host.panels[0] as ModelPickerPanel
    panel.handleInput(ENTER)
    await expect(pending).resolves.toEqual({
      kind: 'error',
      text: 'cannot switch to deepseek-official/deepseek-chat: model "deepseek-chat" does not accept image input, but this session already contains images; select an image-capable model',
    })
    expect(ui.selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
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
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    const persist = vi.fn().mockImplementation(() => Promise.reject('disk gone'))
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
