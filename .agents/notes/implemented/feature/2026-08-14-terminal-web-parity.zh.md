# Agent Note: 终端与 Web 界面的能力对齐

Status: implemented

[English](2026-08-14-terminal-web-parity.md) | 中文

## 问题

不带参数的 `dsh` 打开终端，因此终端是使用者最先接触的界面。它的交互远落后于与它共享同一 agent 平面的 Web 界面，而且差距分布并不均匀：有些能力确实缺失，但另有一整层能力其实已经可达，只是不可见。

已发布的终端会话中有七条命令可以解析——`/compact`、`/exit`、`/feedback`、`/goal`、`/permission`、`/plan`、`/quit`。屏幕上没有任何东西表明它们存在，也看不到当前目标是什么、是否处于计划模式、适用哪个权限预设。Web 界面为其中每一项都提供了常驻元素。

输入 `/` 或 `@` 没有任何反应。Web 界面会在光标处识别这两个字符并给出分组候选菜单（[`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)），读者正是借此在不查文档的情况下发现命令、技能和文件引用。终端里，发现这件事根本没有入口。

终端已经依赖一个提供了大部分缺失机制的框架。`dsh-tui` 从 `@earendil-works/pi-tui` 引入了 `Editor`、`ScrollView`、`Text`、`VStack`、`Markdown`、`TuiAltScreen`、`ProcessTerminal`、`matchesKey` 和 `wrapTextWithAnsi`。`Editor` 自带完整的自动补全——由 provider 驱动的建议、带防抖的查询、按键仲裁，以及用 shell 已传入主题绘制的编辑器内候选列表——因此输入触发不需要第二套菜单实现；`SelectList`、`SettingsList`、`Loader` 与 `Image` 仍未引入，它们属于第 C 层的界面。

## 决策

DeepSeek Harness 分三层交付终端与 Web 界面的能力对齐，每层可独立发布。**第 A 层与第 B 层已实现**；**第 C 层中模型选择已实现**，其余推迟如下。

### 第 C 层（模型选择）——终端模型选择器

`/model` 以终端形态提供与 Web 端 [`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md) 两个入口相同的模型选择能力：不带参数时在对话之上打开键盘面板（带编号的行、当前路由带标记、方向键或数字选择、`enter` 应用、`esc` 撤销且不取消运行中的回合、不清空排队的提示）；带参数时直接切换，未知 id 大声失败并列出可选路由。候选来自活跃的 `ctx.llm` 适配器注册表 —— 与 Web 宿主以 `session.models` 下发的是同一来源 —— 因为浏览器侧的 `ModelDirectoryResolver` 是一张进程内终端组合既无法也不应绕过的客户端 RPC 缓存；直接读取注册表使两个界面的目录保持一致。选中的路由经 `ctx.llm.resolveCallConfig` 校验 —— 与宿主的 `session.selectModel` 一致，包括物化该模型的默认推理强度 —— 并且当排队或已记录的内容携带图片时，声明不接受图片输入的模型会在拾取时被拒绝，与同一处理器的防护一致。拾取写入本前门安装的 `ModelSelectionRef`，因此切换在下一个提示组装边界生效，下一个请求头将其持久化；切换本身没有新的会话事件。拾取同时经 `ctx.agentDefaultModel.saveSelection()` 持久化为部署默认值 —— 与 Web 端“默认值跟随选择器”的规则一致 —— 保存失败作为警告附在切换提示上，而不是让拾取失败。

选择本身在每次读取时通过与 Web 端 `selectionFor` 相同的三层解析：先本进程内的拾取，其次会话的最后一个已记录请求头，再次是启动固定值或部署默认值（按读取时活跃状态取值）。正是这条读取路径使 `dsh --resume <session>` 能够恢复会话中途切换的路由：日志中的请求头优先于创建选项，而空白会话能读到创建之后保存的默认值。页脚与窗格标题在切换生效的那一刻重述路由 —— 并且在重放已恢复日志的 `request/context` 之后同样重述 —— 而连一行候选都放不下的终端上面板让位，并给出直接选择形式的提示。

### 第 A 层——把已经可用的东西显示出来

终端页脚从已拥有这些数据的服务读取常驻会话状态：

- [`@deepseek-ai/dsh-goal`](../../../../packages/goal/goal/README.md) 提供当前目标；已完成的目标会被隐藏，与 Web 端 `GoalBar` 的行为一致。
- [`@deepseek-ai/dsh-plan-mode`](../../../../packages/plan/plan-mode/README.md) 提供计划模式状态；当有效目标为激活时页脚显示 `plan`，当一条待处理的 `/plan` 选择在等待下一次被接受的 pre-step 时显示 `plan*`。
- [`@deepseek-ai/dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.md) 提供有效的预设名称，包括派生的 `custom` 状态。

[`dsh-tui`](../../../../packages/ui/tui/README.md) 通过 `ctx.get()` 解析每个服务，并把一个读取闭包传给 `TerminalShell`。这些读取器是可选的，因此没有 goal、plan-mode 或 permission-presets 的合成只会省略对应的指示器。页脚继续把每一条显示的字符串都经过 `displayText()`，因此不可信的模型或工具文本无法借由新路径重绘屏幕。

### 第 B 层——输入触发管线

编辑器基于 pi-tui 的自动补全提供两个触发菜单（[`autocomplete.ts`](../../../../packages/ui/tui/src/autocomplete.ts)），对应 Web 端两个键入式来源：

- 在输入开头键入 `/` 列出活跃 [`ctx.commands`](../../../../packages/interaction/commands/README.md) 注册表为被驱动 agent 解析的命令。provider 在每次查询时读取 `commands.list(agent)`，因此屏幕启动后注册的命令会在下一次击键时出现，被遮蔽的命令随之消失，无需重启。
- 在词边界键入 `@` 列出本会话**正在运行的子 agent** —— 与 Web 端 `@` 来源读取的是同一份名册（`ctx.subagents.listChildren` 过滤到运行中，对应 [`ui-subagent`](../../../../packages/client/ui-subagent/README.md)）。子 agent 的名字依次取其持久会话标题、创建标签、原始 id，与 Web 端会话列表的标题优先阶梯一致。未组合 subagent 能力时 `@` 不提供候选。文件补全被有意排除：Web 端没有文件补全来源，同一按键下换成另一种功能会使两端分叉。
- 候选的标签、描述与补全值在编辑器绘制或插入前都经过 `displayLine()`，注册表文本与受模型影响的标题无法把控制字节带到屏幕或草稿。
- `/help` 是一条真实命令，与 `exit`/`quit` 一起注册，其文本列出活跃注册表——页脚的 `/help` 提示指向一条可解析的命令，运行它不会开启模型回合。
- 选中的 `/` 候补全为命令行并经注册表提交，因此永远不会到达模型。选中的 `@` 候选把引用 `@name ` 插入输入框并原样送达模型——即 Web 端的纯文本拾取分支；agent 端对 `@` 引用的消费在两端都是未来的业务工作。
- 菜单打开时 `esc` 只关闭菜单：shell 在中断分支之前把该键交给编辑器，因为 `Agent.cancel` 会清空排队工作，而一个菜单不构成丢失它的理由。`ctrl+c` 仍是唯一的一键中断；页脚运行提示写的是 `ctrl+c` 而非 `esc`。

降级：菜单收敛到页脚、编辑器与一行对话记录之外剩余的行数（`menuRowsFor`），连一行候选都放不下的终端——经过压力测试的 20x5——根本不创建菜单，因此不存在要渲染或捕获按键的隐形列表；触发键保持无效，`enter` 提交字面文本。`maxSuggestions` 约束该收敛之前的行数；调色板同时服务于两个菜单，因此 `color: false` 以相同布局无样式渲染。

可达子集：pi-tui 的编辑器按其现状只在首行开头检测 `/`、只在词边界检测 `@`，渲染单个扁平列表，并在 `enter` 确认的同一击键内应用补全并提交。行中的 `/`、标点后的 `@`、后续行上的触发符以及按来源分组的小标题都需要 fork 编辑器——被优先使用依赖而非手写的政策否决，并作为声明的分歧记入 `dsh-tui` 的 README 限制。

### 对齐不意味着什么

终端对齐指的是能力对齐，而非布局对齐。Web 界面由具名插槽组合而成（`conversation.input.dock`、`sidebar.workspaces`、`conversation.session.header.actions`）；终端只有一个视口、一个输入区和一条页脚。某项能力在 Web 上呈现为常驻卡片，在终端可以是页脚字段、瞬时通知或浮层，按其需要支撑的阅读方式逐项决定。

## 曾考虑的替代方案

**先把终端改接到 JSON-RPC 协议上。** 终端直接读取 `ctx.agents`、`ctx.tools` 与 `ctx.timer`，而 [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) 已经把同一个 agent 平面提供给进程外客户端。把终端变成协议客户端是一项真实的架构改进，且协议需要补上它目前缺少的交互方法——它承载 `initialize`、`session/prompt`、`shutdown` 以及 `session.event` 和 `session.status` 通知，没有审批请求、取消或引导方法。那项工作与本项正交：一项能力如何绘制，并不取决于其数据来自注入的服务还是传输层，因此先做对齐可以在不提前付出代价的前提下保留架构选项。

**让终端使用者改用 Web 界面。** 这是目前事实上的答案，也正是终端落后的原因。它在终端存在的意义上失败：使用者已经在 shell 中、通过 SSH 连接、或没有浏览器。

**手写候选菜单。** 以与[优先使用依赖而非手写的政策](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)相同的理由否决：pi-tui 的自动补全能删除自有代码与测试，而第二套建议实现会与编辑器自身的按键处理产生漂移。

## 结果

`dsh-tui` 包新增了对 `@deepseek-ai/dsh-goal`、`@deepseek-ai/dsh-plan-mode` 和 `@deepseek-ai/dsh-permission-presets` 的可选 peer 依赖，使页脚能够读取权威状态而不必在终端里重新折叠会话事件。当这些服务被合成时，终端会话现在会显示当前目标、计划模式和权限预设；每个指示器在其状态不存在时都会消失。原有的页脚字段（运行状态、路由、上下文占用、todo 计划、排队深度、控制提示）保留在新指示器之后的位置。

终端只有一个视口，每个新增指示器都在与对话记录争夺行数。第 A 层通过隐藏已完成目标、截断过长目标、以及在状态缺失时隐藏指示器来缓解；第 B 层的菜单收敛到页脚、编辑器与一行对话记录之外剩余的行数，并在连一行候选都放不下的终端上完全让位；第 C 层的模型选择面板复用同一行阈值，后续第 C 层画面仍需为经过压力测试的 20x5 场景制定各自的降级规则。

`/` 菜单只按注册表的名称序列出命令，没有 Web 端按来源分组的小标题，也没有组合技能来源，因此 `/` 下只出现命令；Web 端的技能来源尚无终端对应物。

## 验证

- `packages/ui/tui/tests/status.spec.ts` 覆盖目标、计划模式和权限预设的格式化，包括缺失时的省略，以及页脚运行提示写的是 `ctrl+c`。
- `packages/ui/tui/tests/shell.spec.ts` 覆盖新读取器触发的页脚更新、读取器缺失时隐藏指示器，并端到端驱动输入触发菜单：活跃名册的提供与收窄、esc 关闭菜单而不取消 agent（排队工作保留）、键盘选择与 tab 补全、`@` 拾取逐字落入 `@name `、斜杠拾取经注册表提交、行阈值在过小终端上让触发键保持无效而 `enter` 提交字面文本、行数收敛，以及 `color` 关闭时菜单布局不变。
- `packages/ui/tui/tests/tui.spec.ts` 使用真实的 `dsh-goal` 和 `dsh-plan-mode` 服务以及 permission-preset 读取器挂载插件，并断言页脚反映实时服务状态；同时证明 `/help` 从活跃注册表应答且不产生任何 `user/message` 或 `turn/start` 事件、挂载后注册的命令会被列出、经真实输入监听器的 esc 在菜单打开时绝不到达 `Agent.cancel`（无菜单时仍中断）、携带控制字节的描述只能以可见的 `\xNN` 转义到达屏幕、`@` 菜单经组合的名册列出运行中子 agent 且没有名册时不提供候选，以及销毁插件 fiber 会移除每条终端自有命令。
- `packages/ui/tui/tests/autocomplete.spec.ts` 覆盖候选取值与净化（包括含 OSC 序列的名字）、列出子 agent 的名字阶梯与运行判定、`@` 词元提取、行预算、活跃名册读取、名册读取失败的包容、两个触发符的补全语义，以及文件补全永不触发；`command-help.spec.ts` 覆盖 `/help` 列表文本。
- `packages/ui/tui/tests/pty-boot.spec.ts` 在真实 PTY 下启动发布组合：斜杠菜单由活跃组合绘制、`/help` 打印列表且 mock 模型服务零请求、页脚保持 `0 tokens`、菜单打开时的 esc 让运行中的回合及其排队后续都送达模型，20x5 终端不显示菜单而输入保持可用。`/model` 的 PTY 用例驱动合并的交互 harness（`apps/cli/tests/tui-interaction.harness.ts`）：选择面板列出组合公布的路由、运行中的回合带排队后续时 esc 使两者都送达模型、数字拾取在会话中途切换且在任何后续请求出现之前页脚即重述路由、下一个请求的线上报体携带新模型、直接 `/model <id>` 切换而未知 id 大声失败并列出可选路由、20x5 终端不显示面板而键入仍到达编辑器，以及在同一个 harness home 上两次启动的 `--resume` 无需任何拾取即从持久化日志恢复切换过的路由。
- `packages/ui/tui/tests/model-picker.spec.ts` 覆盖真实 `ctx.llm` 注册表上的候选取值（注册顺序、按提供方的失败包容、名字净化）、参数匹配（唯一 id、`provider/model`、歧义、未知）、选择的应用（`resolveCallConfig` 校验、默认推理强度物化、拒绝时保留原路由、对排队与已记录内容的图片防护）、默认值持久化（安装后保存、保存失败降级为警告、无持久化回调）、面板的渲染、滚动、键盘结算、撤销、超出数字键可达范围的行不加编号，以及 `color` 关闭时布局不变，并覆盖命令的退化路径（无 llm 服务、空目录、小终端行阈值）。
- `packages/ui/tui/tests/tui.spec.ts` 的模型选择读取路径套件覆盖真实会话上的三层解析（空白会话经固定值与默认值回退、已记录请求头优先于两者、拾取优先于日志、默认值按读取时活跃状态取值），并挂载一个“恢复形态”的会话，其重放的日志命名页脚、窗格标题与选择面板中带标记的路由。

## 推迟

**第 C 层——其余的终端画面。** 此处每一项都需要终端尚不具备的界面：[`ui-trajectory`](../../../../packages/client/ui-trajectory/README.md)、[`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md)、[`ui-workspace`](../../../../packages/client/ui-workspace/README.md)、[`ui-jobs`](../../../../packages/client/ui-jobs/README.md)、[`ui-subagent`](../../../../packages/client/ui-subagent/README.md)、[`ui-deliverables`](../../../../packages/client/ui-deliverables/README.md)、[`ui-attachment`](../../../../packages/client/ui-attachment/README.md)，以及 `ui-settings` 系列。其中两项可以关闭 `dsh-tui` 仍记录为推迟的限制：缺失的会话切换器与行内图片，后者以 pi-tui 的 `Image` 组件为机制。同样推迟的还有编辑器层的触发检测本身（行中的 `/`、标点后的 `@`、后续行上的触发符、分组小标题），那需要一个支持它们的编辑器。
