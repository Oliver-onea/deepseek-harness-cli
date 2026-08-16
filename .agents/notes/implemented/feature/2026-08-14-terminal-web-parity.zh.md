# Agent Note: 终端与 Web 界面的能力对齐

Status: implemented

[English](2026-08-14-terminal-web-parity.md) | 中文

## 问题

不带参数的 `dsh` 打开终端，因此终端是使用者最先接触的界面。它的交互远落后于与它共享同一 agent 平面的 Web 界面，而且差距分布并不均匀：有些能力确实缺失，但另有一整层能力其实已经可达，只是不可见。

已发布的终端会话中有七条命令可以解析——`/compact`、`/exit`、`/feedback`、`/goal`、`/permission`、`/plan`、`/quit`。屏幕上没有任何东西表明它们存在，也看不到当前目标是什么、是否处于计划模式、适用哪个权限预设。Web 界面为其中每一项都提供了常驻元素。

输入 `/` 或 `@` 没有任何反应。Web 界面会在光标处识别这两个字符并给出分组候选菜单（[`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)），读者正是借此在不查文档的情况下发现命令、技能和文件引用。终端里，发现这件事根本没有入口。

终端已经依赖一个提供了大部分缺失机制的框架。`dsh-tui` 从 `@earendil-works/pi-tui` 引入了 `Editor`、`ScrollView`、`Text`、`VStack`、`Markdown`、`TuiAltScreen`、`ProcessTerminal`、`matchesKey` 和 `wrapTextWithAnsi`。`Editor` 自带完整的自动补全——由 provider 驱动的建议、带防抖的查询、按键仲裁，以及用 shell 已传入主题绘制的编辑器内候选列表——因此输入触发不需要第二套菜单实现；`SelectList`、`SettingsList`、`Loader` 与 `Image` 仍未引入，它们属于第 C 层的界面。

## 决策

DeepSeek Harness 分三层交付终端与 Web 界面的能力对齐，每层可独立发布。**第 A 层与第 B 层已实现**；**第 C 层推迟**，记录如下。

### 第 A 层——把已经可用的东西显示出来

终端页脚从已拥有这些数据的服务读取常驻会话状态：

- [`@deepseek-ai/dsh-goal`](../../../../packages/goal/goal/README.md) 提供当前目标；已完成的目标会被隐藏，与 Web 端 `GoalBar` 的行为一致。
- [`@deepseek-ai/dsh-plan-mode`](../../../../packages/plan/plan-mode/README.md) 提供计划模式状态；当有效目标为激活时页脚显示 `plan`，当一条待处理的 `/plan` 选择在等待下一次被接受的 pre-step 时显示 `plan*`。
- [`@deepseek-ai/dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.md) 提供有效的预设名称，包括派生的 `custom` 状态。

[`dsh-tui`](../../../../packages/ui/tui/README.md) 通过 `ctx.get()` 解析每个服务，并把一个读取闭包传给 `TerminalShell`。这些读取器是可选的，因此没有 goal、plan-mode 或 permission-presets 的合成只会省略对应的指示器。页脚继续把每一条显示的字符串都经过 `displayText()`，因此不可信的模型或工具文本无法借由新路径重绘屏幕。

### 第 B 层——输入触发管线

编辑器基于 pi-tui 的自动补全提供两个触发菜单（`CombinedAutocompleteProvider` 之上的一层薄封装，[`autocomplete.ts`](../../../../packages/ui/tui/src/autocomplete.ts)）：

- 在输入开头键入 `/` 列出活跃 [`ctx.commands`](../../../../packages/interaction/commands/README.md) 注册表为被驱动 agent 解析的命令。封装层在每次查询时读取 `commands.list(agent)`，因此屏幕启动后注册的命令会在下一次击键时出现，被遮蔽的命令随之消失，无需重启。
- 在词边界键入 `@` 通过 `fd`/`fdfind` 二进制（可用 `fileFinderPath` 配置；没有查找器则 `@` 不提供候选）列出工作目录下的工作区文件。
- 候选的标签与描述在编辑器绘制前经过 `displayLine()`；补全值保持字面量，使选中的候选插入的正是查到的内容。
- `/help` 是一条真实命令，与 `exit`/`quit` 一起注册，其文本列出活跃注册表——页脚的 `/help` 提示指向一条可解析的命令，运行它不会开启模型回合。
- 选中的 `/` 候补全为命令行并经注册表提交，因此永远不会到达模型；选中的 `@` 候选把文件路径作为纯引用文本插入并随提示提交——即 Web 端的纯文本拾取分支。终端没有引用或附件管线（没有 U+FFFC 占位符，没有按来源的编解码器）；那套机制属于未来的附件能力，而把拾取静默降级为什么都不做，比诚实的路径文本更糟。

降级：菜单收敛到页脚、编辑器与一行对话记录之外剩余的行数（`menuRowsFor`），连一行候选都放不下的终端——经过压力测试的 20x5——干脆不显示菜单。`maxSuggestions` 约束该收敛之前的行数；调色板同时服务于两个菜单，因此 `color: false` 以相同布局无样式渲染。

### 对齐不意味着什么

终端对齐指的是能力对齐，而非布局对齐。Web 界面由具名插槽组合而成（`conversation.input.dock`、`sidebar.workspaces`、`conversation.session.header.actions`）；终端只有一个视口、一个输入区和一条页脚。某项能力在 Web 上呈现为常驻卡片，在终端可以是页脚字段、瞬时通知或浮层，按其需要支撑的阅读方式逐项决定。

## 曾考虑的替代方案

**先把终端改接到 JSON-RPC 协议上。** 终端直接读取 `ctx.agents`、`ctx.tools` 与 `ctx.timer`，而 [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) 已经把同一个 agent 平面提供给进程外客户端。把终端变成协议客户端是一项真实的架构改进，且协议需要补上它目前缺少的交互方法——它承载 `initialize`、`session/prompt`、`shutdown` 以及 `session.event` 和 `session.status` 通知，没有审批请求、取消或引导方法。那项工作与本项正交：一项能力如何绘制，并不取决于其数据来自注入的服务还是传输层，因此先做对齐可以在不提前付出代价的前提下保留架构选项。

**让终端使用者改用 Web 界面。** 这是目前事实上的答案，也正是终端落后的原因。它在终端存在的意义上失败：使用者已经在 shell 中、通过 SSH 连接、或没有浏览器。

**手写候选菜单。** 以与[优先使用依赖而非手写的政策](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)相同的理由否决：pi-tui 的自动补全能删除自有代码与测试，而第二套建议实现会与编辑器自身的按键处理产生漂移。

## 结果

`dsh-tui` 包新增了对 `@deepseek-ai/dsh-goal`、`@deepseek-ai/dsh-plan-mode` 和 `@deepseek-ai/dsh-permission-presets` 的可选 peer 依赖，使页脚能够读取权威状态而不必在终端里重新折叠会话事件。当这些服务被合成时，终端会话现在会显示当前目标、计划模式和权限预设；每个指示器在其状态不存在时都会消失。原有的页脚字段（运行状态、路由、上下文占用、todo 计划、排队深度、控制提示）保留在新指示器之后的位置。

终端只有一个视口，每个新增指示器都在与对话记录争夺行数。第 A 层通过隐藏已完成目标、截断过长目标、以及在状态缺失时隐藏指示器来缓解；第 B 层的菜单收敛到页脚、编辑器与一行对话记录之外剩余的行数，并在连一行候选都放不下的终端上完全让位；第 C 层仍需为经过压力测试的 20x5 场景制定自己的降级规则。

`/` 菜单只按注册表的名称序列出命令，没有 Web 端按来源分组的小标题；技能来源可以注册自己的候选，但目前尚无终端组合挂载它。

## 验证

- `packages/ui/tui/tests/status.spec.ts` 覆盖目标、计划模式和权限预设的格式化，包括缺失时的省略。
- `packages/ui/tui/tests/shell.spec.ts` 覆盖新读取器触发的页脚更新、读取器缺失时隐藏指示器，并端到端驱动输入触发菜单：活跃名册的提供与收窄、esc 关闭、键盘选择与 tab 补全、`@` 文件拾取、斜杠拾取经注册表提交、小终端的收敛与完全抑制，以及 `color` 关闭时菜单布局不变。
- `packages/ui/tui/tests/tui.spec.ts` 使用真实的 `dsh-goal` 和 `dsh-plan-mode` 服务以及 permission-preset 读取器挂载插件，并断言页脚反映实时服务状态；同时证明 `/help` 从活跃注册表应答且不产生任何 `user/message` 或 `turn/start` 事件、挂载后注册的命令会被列出，以及销毁插件 fiber 会移除每条终端自有命令。
- `packages/ui/tui/tests/autocomplete.spec.ts` 覆盖候选取值与规范化、行预算、活跃名册读取、委托补全语义、经真实文件查找器的 `@` 搜索，以及 `resolveFileFinder` 的解析与拒绝；`command-help.spec.ts` 覆盖 `/help` 列表文本。
- `packages/ui/tui/tests/pty-boot.spec.ts` 在真实 PTY 下启动发布组合：斜杠菜单由活跃组合绘制、`/help` 打印列表且 mock 模型服务零请求、页脚保持 `0 tokens`、`@` 经真实查找器提供工作区文件，20x5 终端不显示菜单而输入保持可用。

## 推迟

**第 C 层——新的终端画面。** 此处每一项都需要终端尚不具备的界面：[`ui-trajectory`](../../../../packages/client/ui-trajectory/README.md)、[`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md)、[`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md)、[`ui-workspace`](../../../../packages/client/ui-workspace/README.md)、[`ui-jobs`](../../../../packages/client/ui-jobs/README.md)、[`ui-subagent`](../../../../packages/client/ui-subagent/README.md)、[`ui-deliverables`](../../../../packages/client/ui-deliverables/README.md)、[`ui-attachment`](../../../../packages/client/ui-attachment/README.md)，以及 `ui-settings` 系列。其中两项可以关闭 `dsh-tui` 已记录为推迟的限制：缺失的会话切换器与缺失的终端模型选择器。行内图片是第三项，pi-tui 的 `Image` 组件就是其机制。第四项在终端获得引用或附件管线后在此开启：模型序列化的文件引用，以及与 Web 端对齐的技能触发。
