# Agent Note: TUI 作为协议客户端——盘点、可行性与建议

Status: proposed

[English](2026-08-26-tui-as-protocol-client.md) | 中文

## 问题

`dsh` 有两个前门，它们不共享任何协议。终端（`packages/ui/tui`）通过 `ctx.inject`、`ctx.get` 和延迟的 `ctx.inject` 直接访问进程内 Cordis 服务——它是一个恰好会画画的插件，不是任何东西的客户端。SDK 应用服务器（`packages/sdk`）通过 stdio 使用换行分隔的 JSON-RPC 协议，包含 `initialize`、`session/prompt`、`session/steer`、`session/interrupt`、`shutdown` 和 `approval/request`。终端没有使用协议的一个字节。

Codex 是正在模仿的形态：一个应用服务器协议，TUI 只是它最知名的客户端。本笔记盘点终端接触的每一个服务，针对协议对每个服务进行分类，回答决定 TUI *能否*成为协议客户端的三个可行性问题，并估算工作量。

终端-web 对等计划（[2026-08-14-terminal-web-parity.md](../implemented/feature/2026-08-14-terminal-web-parity.md)）认为协议问题与对等性正交。盘点之后，这一判断成立：协议缺口与终端是否绘制 footer 字段或菜单无关。两项工作可以并行推进，互不阻塞。

## 提案

### 服务盘点

终端接触的 15 个服务，按 SDK 协议分类。

| # | 服务 | 访问方式 | 分类 | 理由 |
|---|------|----------|------|------|
| 1 | `agents` | 硬 `inject`（`index.ts:62`） | **已有覆盖** | `session/prompt` 创建 agent；`session/status` 报告生命周期。当前 TUI 持有一个 `Agent` 引用，但协议客户端持有一个 `sessionId` 句柄，通过协议驱动相同的操作。 |
| 2 | `tools` | 硬 `inject`（`index.ts:62`） | **归入会话状态** | 工具注册表仅用于 `createPresenter()`（`index.ts:217`），其解析 `presentCall`/`presentResult`。视图是纯 JSON 数据（见可行性分析）。协议已通过 `session.event` 流式传输 `tool/call` 和 `tool/result` 事件；服务器可以将渲染后的视图作为字段附加到这些事件上，终端无需持有工具对象即可绘制。 |
| 3 | `timer` | 硬 `inject`（`index.ts:62`） | **保持本地** | Cordis 内置。用于 `ctx.interval()` 每秒刷新已用时间 footer（`index.ts:413`）。这是渲染循环关注点，没有模型可见组件。 |
| 4 | `appExit` | `ctx.get`（`index.ts:310,425`） | **保持本地** | `process.exit()` 是宿主关注点。协议的 `shutdown` 方法销毁服务器；收到关闭响应或 EOF 的 TUI 客户端自行退出进程。 |
| 5 | `agentDefaultModel` | `ctx.get`（`index.ts:327,332,462`） | **需要新方法** | 两个操作：读取部署默认值（`currentSelection()`）和持久化选择（`saveSelection()`）。读取归入 `session/status`，作为 `defaultModel?: {provider, model}`。写入是动作：`session/selectModel`，参数 `{sessionId, provider, model, reasoningEffort?}`，结果 `{accepted: boolean, reason?}`。 |
| 6 | `goals` | `ctx.get`（`index.ts:336`） | **归入会话状态** | Footer 读取 `goals.get(agent)` 来显示当前目标和阶段。丰富 `session/status`，增加 `goal?: {objective: string, phase: 'active' | 'complete'}`。隐藏已完成目标的读取闭包是终端本地的渲染决策。 |
| 7 | `planMode` | `ctx.get`（`index.ts:337`） | **归入会话状态** | Footer 读取 `planMode.get(agent)` 来显示 `plan`/`plan*` 指示器。丰富 `session/status`，增加 `planMode?: {state: 'active' | 'pending' | 'off'}`。 |
| 8 | `permissionPresets` | `ctx.get`（`index.ts:338`） | **归入会话状态** | Footer 读取 `permissionPresets.current(agent.session.events)`。丰富 `session/status`，增加 `permissionPreset?: string`。从会话事件推导是服务器端计算。 |
| 9 | `commands` | `ctx.get` + 延迟 `ctx.inject`（`index.ts:339,426`） | **需要新方法** | 两个操作：列出注册表为 agent 解析的命令（`commands.list(agent)`），以及执行命令（`commands.execute(agent, line)`）。终端还通过延迟注入注册了 `exit`、`quit`、`help` 和 `model` 命令。新方法：`command/list` — 参数 `{sessionId}`，结果 `{commands: {name: string, description: string, input?: {hint: string}}[]}`。`command/execute` — 参数 `{sessionId, line: string}`，结果 `{kind: 'success' | 'error', text: string}`。`exit`/`quit` 命令映射到 `shutdown`；`model` 映射到 `session/selectModel`；`help` 是 `command/list` 结果的渲染。 |
| 10 | `skills` | `ctx.get`（`index.ts:340`） | **需要新方法** | `/` 菜单通过 `skills.list({cwd, signal, scope: agent})` 读取用户可调用技能目录。新方法：`skill/list` — 参数 `{sessionId}`，结果 `{skills: {name: string, description: string, modelInvocable: boolean}[]}`。`user-only` 标记和净化是终端本地的渲染决策。 |
| 11 | `subagents` | `ctx.get`（`index.ts:341`） | **需要新方法** | `@` 菜单通过 `subagents.listChildren(agent.session.id, signal)` 读取运行中的子进程。新方法：`subagent/listChildren` — 参数 `{sessionId}`，结果 `{children: {name: string, id: string}[]}`。`subagent.started`/`subagent.finished` 通知已存在；服务器可以从这些信号维护运行中的集合。 |
| 12 | `llm` | `ctx.get`（`index.ts:342`） | **需要新方法** | 模型选择器读取实时适配器注册表（`llm.listProviders()`）并解析每个路由的模型信息。新方法：`model/list` — 参数 `{}`，结果 `{models: {provider: string, model: string, reasoningEfforts?: string[]}[]}`。选择器的渲染（编号行、键盘导航、effort 层级）保持终端本地。 |
| 13 | `tokenMeter` | `ctx.get`（`index.ts:349`） | **归入会话状态** | Footer 从计量器读取 token 计数。丰富 `session/status`，增加 `tokens?: {input: number, output: number, cache?: number}`。计量器的实时更新已通过 `session.event` 到达（`assistant/chunk` 和 `request/context` 事件携带 token 计数）；status 字段是便利聚合。 |
| 14 | `userQuestions` | 延迟 `ctx.inject`（`index.ts:418`） | **模式已有覆盖** | 终端注册了一个 `TerminalQuestions` 提供者，渲染键盘面板。协议的 `approval/request` 服务器→客户端请求是相同模式：服务器询问，客户端回答。`userQuestions/ask` 服务器→客户端请求将镜像它：参数 `{sessionId, questions: AskUserQuestionItem[]}`，结果 `{answers: AskUserQuestionAnswerItem[]}`。 |
| 15 | `approval` | 延迟 `ctx.inject`（`index.ts:421`） | **已有覆盖** | `approval/request` 服务器→客户端请求已存在，参数 `{sessionId, toolName, callId?, reason?}`，结果 `{outcome: 'allowed-once' | 'rejected'}`。终端的 `installApprovalAnswerer`（`approval.ts:64`）通过和 `userQuestions` 相同的面板回答。 |

**总结：** 3 个服务已有覆盖，4 个归入会话状态，5 个需要新方法，3 个保持本地。

### 可行性

#### 1. 工具渲染意图能否经受序列化？

**能。** `ToolCallView` 和 `ToolResultView` 的每一个变体都是纯 JSON 格式的数据。

`ToolCallView`（`packages/core/tools/src/presentation.ts:46`）：
- `GenericCallView`（`presentation.ts:53`）：`{card: 'generic', title: string, kind?: ToolCallKind, rawInput?: unknown, content?: ContentBlock[], locations?: FileLocation[]}`。`ToolCallKind` 是字符串联合类型（`presentation.ts:15`）。`FileLocation` 是 `{path: string, line?: number}`（`presentation.ts:23`）。
- `TerminalCallView`（`presentation.ts:84`）：`{card: 'terminal', title: string, description?: string, cwd?: string}` —— 全是字符串。
- `DiffCallView`（`presentation.ts:110`）：`{card: 'diff', title: string, diffs: FileDiff[], locations?: FileLocation[]}`。`FileDiff` 是 `{path: string, oldText: string | null, newText: string}`（`presentation.ts:34`）。

`ToolResultView`（`presentation.ts:140`）：
- `GenericResultView`（`presentation.ts:146`）：`{card: 'generic', title?: string, content?: ContentBlock[]}`。
- `TerminalResultView`（`presentation.ts:163`）：`{card: 'terminal', title?: string, output?: string, exitCode?: number, signal?: string}`。
- `DiffResultView`（`presentation.ts:184`）：`{card: 'diff', title?: string, diffs: FileDiff[]}`。
- `SearchMatchesResultView`（`presentation.ts:216`）：`{card: 'search', shape: 'matches', title?: string, files: SearchFileMatches[], truncated: boolean, total: number}`。`SearchFileMatches` 是 `{path: string, matches: {lineNumber: number, line: string}[]}`（`presentation.ts:200`）。
- `SearchPathsResultView`（`presentation.ts:238`）：`{card: 'search', shape: 'paths', title?: string, paths: string[], truncated: boolean, total: number}`。
- `ReadResultView`（`presentation.ts:281`）：`{card: 'read', title?: string, path: string, offset: number, lines: {number: number, text: string}[], totalLines: number, lang?: string, content?: ContentBlock[]}`。
- `WebSearchResultView`（`presentation.ts:355`）：`{card: 'web', kind: 'search', title?: string, sources: {url: string, title?: string, snippet?: string, publishedAt?: string}[], answer?: string, truncated: boolean}`。
- `WebFetchResultView`（`presentation.ts:374`）：`{card: 'web', kind: 'fetch', title?: string, url: string, statusCode: number, truncated: boolean}`。

`ContentBlock`（`packages/llm/llm/src/types.ts:110`）是 `{type: 'text', text: string}`、`{type: 'image', ...}` 及其他纯 JSON 对象的可辨识联合类型。

没有任何变体携带函数、类实例、Symbol 或任何不可序列化的值。`presentCall`/`presentResult` 方法被文档化为 `args` 的纯函数（`packages/core/tools/src/index.ts:279,287`），code-mode 示例也确认了这一点（`packages/core/tools/src/code-mode.ts:645`）。服务器可以计算视图并将其附加到 `tool/call` 和 `tool/result` 事件上；终端可以绘制它们而无需持有工具对象。

#### 2. 终端做了哪些协议完全没有词汇表达的事情？

- **输入时的自动补全菜单**（`/` 和 `@`）：终端使用 pi-tui 的 `AutocompleteProvider`（`packages/ui/tui/src/autocomplete.ts:176`）。名单读取（`commands.list()`、`skills.list()`、`subagents.listChildren()`）是缺口——它们需要盘点中列出的新方法。自动补全机制（去抖、模糊过滤、键盘仲裁、`menuRowsFor` 降级）是 pi-tui 编辑器关注点，合理地保持终端本地。协议需要提供数据；终端负责渲染。
- **启动时的恢复选择器**：`pickResumeSession`（`packages/ui/tui/src/resume-picker.ts`）直接读取会话存储。协议没有 `session/list` 或 `session/resume` 方法。这是一个缺口，但它合理地保持终端本地：选择器在 TUI 启动*之前*运行，启动协议服务器的同一启动序列需要先运行选择器。选择器是宿主层面的关注点，不是会话层面的。
- **流式传输部分 assistant 文本**：已有覆盖。协议通过 `session.event` 通知流式传输包括 `assistant/chunk` 事件（`packages/sdk/protocol/src/types.ts:111`）。终端通过 `shell.observe(event)`（`packages/ui/tui/src/index.ts:401`）在到达时渲染它们。
- **计划模式转换**：缺口。协议没有计划模式通知。终端直接读取 `planMode.get(agent)`（`packages/ui/tui/src/index.ts:337`）。此状态需要成为 `session/status` 的一部分或新的通知。
- **排队提示收件箱**：缺口。终端读取 `agent.inbox.nextTurn` 和 `agent.inbox.nextStep`，用于模型选择器中的图像守卫（`packages/ui/tui/src/index.ts:459`）。协议没有收件箱可见性。这是一个狭窄的用例（当排队内容包含图像时，模型选择器拒绝不能接受图像的模型）；收件箱状态可以成为 `session/status` 的一部分。

#### 3. 什么会破坏转录契约？

**不会破坏任何东西。** 终端当前产生的模型可见输入是：
- 用户提示（`shell.prompt(text)` → `agent.followup(message)` → `user/message` 事件）。协议的 `session/prompt` 产生相同的事件。
- 中断（`agent.cancel({kind: 'user'})`）。协议的 `session/interrupt` 产生相同的取消。
- 引导（`agent.steer(message)` → `user/message` 事件）。协议的 `session/steer` 产生相同的事件。

模型选择器（`packages/ui/tui/src/index.ts:332-333`）通过 `installModelSelection(agent.ctx, selection)` 更改选择，这不直接产生模型可见输入——它更改下一次请求的模型路由，路由记录在 `request/context` 事件中。基于协议的 `session/selectModel` 将产生相同的 `request/context` 事件。

每个模型可见输入路径都已经通过 agent 循环，产生会话事件。协议方法是对相同 agent 循环调用的薄封装。将终端移到协议后面不会改变哪些事件被记录。

### 迁移计划

工作分为 7 个可独立合并的 PR。每个 PR 都保持终端正常工作且协议向后兼容。每个 PR 都可以通过无密钥快照测试验证。

#### 步骤 1：用 footer 字段丰富 `session/status`

将 `goal`、`planMode`、`permissionPreset`、`tokens` 和 `defaultModel` 字段添加到 `SessionStatusNotification`。服务器从终端当前读取的相同服务中读取这些值。

- **涉及文件：** 3（`packages/sdk/protocol/src/types.ts`、`packages/sdk/server/src/server.ts`、`packages/sdk/server/tests/`）
- **无密钥快照：** 不需要（变更是附加数据字段；快照测试验证渲染输出，而非协议类型）。
- **规模：** 小。对现有客户端无行为变更。

#### 步骤 2：添加 `model/list` 和 `session/selectModel`

`model/list` 返回实时适配器目录。`session/selectModel` 验证并应用路由选择，通过 `agentDefaultModel` 服务持久化默认值。

- **涉及文件：** 5（协议类型、服务器、服务器测试、协议客户端类型、快照测试工具）
- **无密钥快照：** 是（`session/selectModel` 更改会话的模型路由；快照验证 `request/context` 事件携带新路由）。
- **规模：** 中。模型选择器的渲染保留在终端中；协议只提供数据和动作。

#### 步骤 3：添加 `command/list` 和 `command/execute`

`command/list` 返回会话 agent 的实时命令注册表。`command/execute` 通过命令运行时派发一行。

- **涉及文件：** 4（协议类型、服务器、服务器测试、快照测试工具）
- **无密钥快照：** 是（`command/execute` 产生 `command/run` 事件；快照验证输出）。
- **规模：** 中。`exit`/`quit` 命令映射到现有的 `shutdown` 方法。`help` 命令是 `command/list` 结果的客户端渲染。`model` 命令映射到新的 `session/selectModel`。

#### 步骤 4：添加 `skill/list`

`skill/list` 返回会话 agent 的用户可调用技能目录，按 cwd 和作用域链限定。

- **涉及文件：** 4（协议类型、服务器、服务器测试、快照测试工具）
- **无密钥快照：** 是（快照验证技能目录与实时组合匹配）。
- **规模：** 小。服务器包装现有的 `skills.list()` 调用。

#### 步骤 5：添加 `subagent/listChildren`

`subagent/listChildren` 返回会话的运行中子进程。服务器从现有的 `subagent.started`/`subagent.finished` 通知维护运行中的集合。

- **涉及文件：** 4（协议类型、服务器、服务器测试、快照测试工具）
- **无密钥快照：** 是（快照验证子进程启动和完成后的子进程列表）。
- **规模：** 小。服务器包装现有的 `subagents.listChildren()` 调用。

#### 步骤 6：添加 `userQuestions/ask` 服务器→客户端请求

镜像 `approval/request` 模式：服务器发送 `userQuestions/ask` 请求，客户端通过面板回答。

- **涉及文件：** 4（协议类型、服务器、服务器测试、快照测试工具）
- **无密钥快照：** 是（快照验证问答往返）。
- **规模：** 小。模式已存在于 `approval/request`。

#### 步骤 7：重构 TUI 使用协议客户端

用协议客户端替换 TUI 的直接 `ctx.get`/`ctx.inject` 调用。TUI 插件在进程内挂载服务器（无 IPC——订单中的进程拆分约束成立），终端 shell 驱动协议客户端而非 Cordis 上下文。

- **涉及文件：** ~8（`packages/ui/tui/src/index.ts`、`shell.ts`、`autocomplete.ts`、`approval.ts`、`questions.ts`、`model-picker.ts`、`status.ts`，以及测试）
- **无密钥快照：** 是（`packages/ui/tui/tests/pty-boot.spec.ts` 中现有的 PTY 启动测试验证相同的渲染输出）。
- **规模：** 大。这是唯一改变 TUI 内部架构的步骤。其他每个步骤都是仅协议变更。

**总计：7 个 PR，~32 个文件，除步骤 1 外全部可通过无密钥快照验证。**

### 建议

**不要重构 TUI 使用协议客户端（步骤 7）。构建协议（步骤 1–6），到此为止。**

所有者要求的架构是协议，而不是终端的内部布线。协议已经存在，并且已经承载了核心操作（`session/prompt`、`session/steer`、`session/interrupt`、`session.event`、`session.status`、`approval/request`）。步骤 1–6 关闭了剩余的缺口：协议获得了终端需要的每一个方法，外部客户端现在可以做 TUI 能做的一切。这就是架构——一个应用服务器协议，一个接口。

TUI 的直接服务访问就变成了进程内快速路径，而不是缺失的协议。这与对等笔记命名的模式相同："能力如何绘制不取决于其数据是通过注入服务还是传输到达。" 终端不需要通过传输路由自己的渲染来证明传输存在。Codex 本身在同一个进程中运行 TUI 和应用服务器；价值在于共享接口，而不是 IPC。

6 个仅协议 PR 大约 24 个文件，全部是小到中等规模，可以独立交付。TUI 重构（步骤 7）大约 8 个文件，规模大，其唯一好处是移除 `ctx.get` 调用——代价是在同一进程内将每个 footer 读取、每个菜单查询和每个工具视图都通过 JSON 序列化/反序列化。这是一个为纯度收益而付出的性能退步。

如果终端被重写（例如，不同的 UI 框架，或迁移到独立进程），协议已经就位。在此之前，终端的直接服务访问不是问题——它与 web 界面使用的模式相同（web 主机同样读取 `ctx.llm`、`ctx.commands`、`ctx.skills` 和 `ctx.subagents`），没有人说 web 界面"不是任何东西的客户端"。

## 考虑的替代方案

**完整 TUI 迁移（步骤 7）。** 这是订单要求估算的计划。成本是在六个仅协议 PR 之后的一个大 PR，共 7 个 PR 和 ~32 个文件。收益是架构纯粹性：终端和每个外部客户端共享完全相同的代码路径。成本是真实的：每个 footer 读取、菜单查询和工具视图在同一进程内通过 JSON 序列化，TUI 的渲染路径从直接服务调用变为异步协议往返。当协议已经覆盖每一个操作时，纯粹性收益不足以证明性能成本或迁移风险的合理性。

**完全跳过协议工作。** 终端今天可以正常工作，协议已经覆盖了核心操作。缺失的方法（`model/list`、`command/list`、`skill/list`、`subagent/listChildren`）只有交互式客户端需要——而今天唯一的交互式客户端是终端，它已经有直接访问。这就是所有者不满意的"架构維持現狀"答案。仅协议步骤（1–6）是让架构成真而不为 TUI 迁移付费的最低限度。

**一个大爆炸 PR。** 被拒绝，因为仅协议步骤（1–6）是独立有用且独立可验证的。外部 SDK 客户端可以使用 `model/list` 和 `session/selectModel` 而不必等待 `command/list`。大爆炸 PR 大约 32 个文件，无法审查，且不留下任何终端可工作的中间状态。

## 验收标准

1. 协议中添加 `model/list`、`session/selectModel`、`command/list`、`command/execute`、`skill/list`、`subagent/listChildren` 和 `userQuestions/ask`。
2. `session/status` 丰富为包含 `goal`、`planMode`、`permissionPreset`、`tokens` 和 `defaultModel`。
3. 每个方法都有无密钥快照测试。
4. TUI 不被更改。协议就是架构；TUI 的直接服务访问是记录在案的快速路径。

## 风险

- **仅协议方案可能被拒绝为"仍然不是真正的客户端"。** 所有者可能坚持终端必须通过协议路由来证明架构有效。本笔记的建议认为协议就是架构，终端的进程内路径是有效的快捷方式。如果所有者不同意，步骤 7 必须包含在内。
- **`userQuestions/ask` 破坏了 `approval/request` 模式的简洁性。** 为用户问题添加第二个服务器→客户端请求类型可能被视为不必要，因为终端今天通过同一个面板处理两者。替代方案是将用户问题合并到 `approval/request` 方法中，但两者有不同的 schema 和不同的语义（approval 是二元的允许/拒绝；用户问题是带自由文本答案的多选）。
- **`session/status` 中的 footer 字段可能无限制增长。** 丰富的状态通知携带 goal、plan mode、permission preset、tokens 和 default model。如果每个新的 footer 指示器都添加一个字段，通知将变成一个杂货袋。缓解措施是这五个字段是终端当前读取的完整集合，且没有计划更多的 footer 字段。
- **迁移计划可能被其他工作超越。** 仅协议步骤（1–6）足够小，可以在一周内交付，但它们与剩余的 Tier C 对等项目和其他功能工作竞争。跳过步骤 7 的建议减少了工作量太大以至于永远无法启动的风险。