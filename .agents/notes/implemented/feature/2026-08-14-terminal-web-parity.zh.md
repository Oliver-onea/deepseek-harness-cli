# Agent Note: 终端与 Web 界面的能力对齐

Status: implemented

[English](2026-08-14-terminal-web-parity.md) | 中文

## 问题

不带参数的 `dsh` 打开终端，因此终端是使用者最先接触的界面。它的交互远落后于与它共享同一 agent 平面的 Web 界面，而且差距分布并不均匀：有些能力确实缺失，但另有一整层能力其实已经可达，只是不可见。

已发布的终端会话中有七条命令可以解析——`/compact`、`/exit`、`/feedback`、`/goal`、`/permission`、`/plan`、`/quit`。屏幕上没有任何东西表明它们存在，也看不到当前目标是什么、是否处于计划模式、适用哪个权限预设。Web 界面为其中每一项都提供了常驻元素。

输入 `/` 或 `@` 没有任何反应。Web 界面会在光标处识别这两个字符并给出分组候选菜单（[`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)），读者正是借此在不查文档的情况下发现命令、技能和文件引用。终端里，发现这件事根本没有入口。

终端已经依赖一个提供了大部分缺失机制的框架。`dsh-tui` 从 `@earendil-works/pi-tui` 引入了 `Editor`、`ScrollView`、`Text`、`VStack`、`Markdown`、`TuiAltScreen`、`ProcessTerminal`、`matchesKey` 和 `wrapTextWithAnsi`，却没有引入 `AutocompleteProvider`、`AutocompleteItem`、`AutocompleteSuggestions`、`SelectList`、`SettingsList`、`Loader`、`Image` 中的任何一个——尽管该包导出了全部这些，并且明确支持文件路径与斜杠命令两类自动补全。

## 决策

DeepSeek Harness 分三层交付终端与 Web 界面的能力对齐，每层可独立发布。**第 A 层已实现**：终端页脚无需使用者执行命令即可显示当前目标、计划模式和权限预设。**第 B 层和第 C 层推迟**，记录如下。

### 第 A 层——把已经可用的东西显示出来

终端页脚从已拥有这些数据的服务读取常驻会话状态：

- [`@deepseek-ai/dsh-goal`](../../../../packages/goal/goal/README.md) 提供当前目标；已完成的目标会被隐藏，与 Web 端 `GoalBar` 的行为一致。
- [`@deepseek-ai/dsh-plan-mode`](../../../../packages/plan/plan-mode/README.md) 提供计划模式状态；当有效目标为激活时页脚显示 `plan`，当一条待处理的 `/plan` 选择在等待下一次被接受的 pre-step 时显示 `plan*`。
- [`@deepseek-ai/dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.md) 提供有效的预设名称，包括派生的 `custom` 状态。

[`dsh-tui`](../../../../packages/ui/tui/README.md) 通过 `ctx.get()` 解析每个服务，并把一个读取闭包传给 `TerminalShell`。这些读取器是可选的，因此没有 goal、plan-mode 或 permission-presets 的合成只会省略对应的指示器。页脚继续把每一条显示的字符串都经过 `displayText()`，因此不可信的模型或工具文本无法借由新路径重绘屏幕。

### 对齐不意味着什么

终端对齐指的是能力对齐，而非布局对齐。Web 界面由具名插槽组合而成（`conversation.input.dock`、`sidebar.workspaces`、`conversation.session.header.actions`）；终端只有一个视口、一个输入区和一条页脚。某项能力在 Web 上呈现为常驻卡片，在终端可以是页脚字段、瞬时通知或浮层，按其需要支撑的阅读方式逐项决定。

## 曾考虑的替代方案

**先把终端改接到 JSON-RPC 协议上。** 终端直接读取 `ctx.agents`、`ctx.tools` 与 `ctx.timer`，而 [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) 已经把同一个 agent 平面提供给进程外客户端。把终端变成协议客户端是一项真实的架构改进，且协议需要补上它目前缺少的交互方法——它承载 `initialize`、`session/prompt`、`shutdown` 以及 `session.event` 和 `session.status` 通知，没有审批请求、取消或引导方法。那项工作与本项正交：一项能力如何绘制，并不取决于其数据来自注入的服务还是传输层，因此先做对齐可以在不提前付出代价的前提下保留架构选项。

**让终端使用者改用 Web 界面。** 这是目前事实上的答案，也正是终端落后的原因。它在终端存在的意义上失败：使用者已经在 shell 中、通过 SSH 连接、或没有浏览器。

**手写候选菜单。** 以与[优先使用依赖而非手写的政策](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)相同的理由否决：pi-tui 的自动补全能删除自有代码与测试，而第二套建议实现会与编辑器自身的按键处理产生漂移。

## 结果

`dsh-tui` 包新增了对 `@deepseek-ai/dsh-goal`、`@deepseek-ai/dsh-plan-mode` 和 `@deepseek-ai/dsh-permission-presets` 的可选 peer 依赖，使页脚能够读取权威状态而不必在终端里重新折叠会话事件。当这些服务被合成时，终端会话现在会显示当前目标、计划模式和权限预设；每个指示器在其状态不存在时都会消失。原有的页脚字段（运行状态、路由、上下文占用、todo 计划、排队深度、控制提示）保留在新指示器之后的位置。

终端只有一个视口，每个新增指示器都在与对话记录争夺行数。第 A 层通过隐藏已完成目标、截断过长目标、以及在状态缺失时隐藏指示器来缓解；第 B 层和第 C 层需要为经过压力测试的 20x5 场景制定自己的降级规则。

## 验证

- `packages/ui/tui/tests/status.spec.ts` 覆盖目标、计划模式和权限预设的格式化，包括缺失时的省略。
- `packages/ui/tui/tests/shell.spec.ts` 覆盖新读取器触发的页脚更新，以及读取器缺失时隐藏指示器。
- `packages/ui/tui/tests/tui.spec.ts` 使用真实的 `dsh-goal` 和 `dsh-plan-mode` 服务以及 permission-preset 读取器挂载插件，并断言页脚反映实时服务状态。

## 推迟

**第 B 层——输入触发管线。** 在光标处识别 `/` 与 `@` 并给出分组候选，对应 [`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)、[`ui-commands`](../../../../packages/client/ui-commands/README.md) 与 [`ui-skill`](../../../../packages/client/ui-skill/README.md)。建立在 pi-tui 的 `AutocompleteProvider` 之上。这一层就是终端发现能力的全部。

**第 C 层——新的终端画面。** 此处每一项都需要终端尚不具备的界面：[`ui-trajectory`](../../../../packages/client/ui-trajectory/README.md)、[`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md)、[`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md)、[`ui-workspace`](../../../../packages/client/ui-workspace/README.md)、[`ui-jobs`](../../../../packages/client/ui-jobs/README.md)、[`ui-subagent`](../../../../packages/client/ui-subagent/README.md)、[`ui-deliverables`](../../../../packages/client/ui-deliverables/README.md)、[`ui-attachment`](../../../../packages/client/ui-attachment/README.md)，以及 `ui-settings` 系列。其中两项可以关闭 `dsh-tui` 已记录为推迟的限制：缺失的会话切换器与缺失的终端模型选择器。行内图片是第三项，pi-tui 的 `Image` 组件就是其机制。
