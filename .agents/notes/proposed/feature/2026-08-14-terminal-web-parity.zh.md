# Agent Note: 终端与 Web 界面的能力对齐

Status: proposed

[English](2026-08-14-terminal-web-parity.md) | 中文

## 问题

不带参数的 `dsh` 打开终端，因此终端是使用者最先接触的界面。它的交互远落后于与它共享同一 agent 平面的 Web 界面，而且差距分布并不均匀：有些能力确实缺失，但另有一整层能力其实已经可达，只是不可见。

已发布的终端会话中有七条命令可以解析——`/compact`、`/exit`、`/feedback`、`/goal`、`/permission`、`/plan`、`/quit`。屏幕上没有任何东西表明它们存在，也看不到当前目标是什么、是否处于计划模式、适用哪个权限预设。Web 界面为其中每一项都提供了常驻元素。

输入 `/` 或 `@` 没有任何反应。Web 界面会在光标处识别这两个字符并给出分组候选菜单（[`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)），读者正是借此在不查文档的情况下发现命令、技能和文件引用。终端里，发现这件事根本没有入口。

终端已经依赖一个提供了大部分缺失机制的框架。`dsh-tui` 从 `@earendil-works/pi-tui` 引入了 `Editor`、`ScrollView`、`Text`、`VStack`、`Markdown`、`TuiAltScreen`、`ProcessTerminal`、`matchesKey` 和 `wrapTextWithAnsi`，却没有引入 `AutocompleteProvider`、`AutocompleteItem`、`AutocompleteSuggestions`、`SelectList`、`SettingsList`、`Loader`、`Image` 中的任何一个——尽管该包导出了全部这些，并且明确支持文件路径与斜杠命令两类自动补全。

## 提案

在终端中重现 Web 界面的能力，以 Web 插件集合作为对齐清单，而不是另行发明一份终端功能列表。每项 Web 能力都对应 `packages/client/` 下的一个浏览器插件，终端要做的是为同一能力给出终端形态——而不是移植 React 组件，那些在终端没有对应物。

工作按成本分为三层，并按下列顺序独立交付。

### 第 A 层——把已经可用的东西显示出来

为已经生效的命令提供可见状态。它们各自所需的数据都已存在于会话中，缺的只是渲染。

| Web 插件 | 终端缺口 |
|---|---|
| [`ui-goal`](../../../../packages/client/ui-goal/README.md) | `/goal` 设定的目标从不显示。 |
| [`ui-plan`](../../../../packages/client/ui-plan/README.md) | `/plan` 切换的模式没有任何指示。 |
| [`ui-permission-presets`](../../../../packages/client/ui-permission-presets/README.md) | `/permission` 切换的预设读者看不到。 |
| [`ui-message-feedback`](../../../../packages/client/ui-message-feedback/README.md) | `/feedback` 以会话为范围；Web 界面把反馈附着到单条消息。 |

### 第 B 层——输入触发管线

在光标处识别 `/` 与 `@` 并给出分组候选，对应 [`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)、[`ui-commands`](../../../../packages/client/ui-commands/README.md) 与 [`ui-skill`](../../../../packages/client/ui-skill/README.md)。建立在 pi-tui 的 `AutocompleteProvider` 之上，而不是手写菜单：候选来源、建议状态与键盘仲裁才是这件事昂贵的部分，而框架已经拥有它们。

这一层就是终端发现能力的全部。界面上没有任何其他地方提及命令，因此在它落地之前，读者只能从本仓库得知命令集，否则无从知晓。

### 第 C 层——新的终端画面

此处每一项都需要终端尚不具备的界面，且各自是独立的变更：[`ui-trajectory`](../../../../packages/client/ui-trajectory/README.md)（按轮次组织的事件账本）、[`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md)（会话列表与新建会话）、[`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md)、[`ui-workspace`](../../../../packages/client/ui-workspace/README.md)、[`ui-jobs`](../../../../packages/client/ui-jobs/README.md)、[`ui-subagent`](../../../../packages/client/ui-subagent/README.md)、[`ui-deliverables`](../../../../packages/client/ui-deliverables/README.md)、[`ui-attachment`](../../../../packages/client/ui-attachment/README.md)，以及 `ui-settings` 系列。

其中两项可以关闭 [`dsh-tui`](../../../../packages/ui/tui/README.md) 已记录为推迟的限制：缺失的会话切换器与缺失的终端模型选择器。行内图片是第三项，pi-tui 的 `Image` 组件就是其机制。

### 对齐不意味着什么

终端对齐指的是能力对齐，而非布局对齐。Web 界面由具名插槽组合而成（`conversation.input.dock`、`sidebar.workspaces`、`conversation.session.header.actions`）；终端只有一个视口、一个输入区和一条页脚。某项能力在 Web 上呈现为常驻卡片，在终端可以是页脚字段、瞬时通知或浮层，按其需要支撑的阅读方式逐项决定。

## 曾考虑的替代方案

**先把终端改接到 JSON-RPC 协议上。** 终端直接读取 `ctx.agents`、`ctx.tools` 与 `ctx.timer`，而 [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) 已经把同一个 agent 平面提供给进程外客户端。把终端变成协议客户端是一项真实的架构改进，且协议需要补上它目前缺少的交互方法——它承载 `initialize`、`session/prompt`、`shutdown` 以及 `session.event` 和 `session.status` 通知，没有审批请求、取消或引导方法。那项工作与本项正交：一项能力如何绘制，并不取决于其数据来自注入的服务还是传输层，因此先做对齐可以在不提前付出代价的前提下保留架构选项。

**让终端使用者改用 Web 界面。** 这是目前事实上的答案，也正是终端落后的原因。它在终端存在的意义上失败：使用者已经在 shell 中、通过 SSH 连接、或没有浏览器。

**手写候选菜单。** 以与[优先使用依赖而非手写的政策](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)相同的理由否决：pi-tui 的自动补全能删除自有代码与测试，而第二套建议实现会与编辑器自身的按键处理产生漂移。

## 验收标准

第 A 层的完成标准是：终端会话无需读者执行命令即可显示当前目标、计划模式与权限预设，且每个指示器在其状态不存在时消失。

第 B 层的完成标准是：输入 `/` 列出实时注册表为该 agent 解析出的命令，输入 `@` 给出工作区文件候选；两者都可关闭、都可用键盘选择，且在选中候选后都不会以字面文本抵达模型。

每一层交付时都附带一份通过真实可运行示例产生的免密钥快照，依据[测试政策](../../../../docs/testing.md)，因为每一项都改变产品使用者可见的输出。第 B 层还需证明候选列表派生自实时注册表，使挂载后注册的命令或技能无需重启即可出现。

终端的每个字符串继续经过 `displayText()`，因此不可信的模型或工具文本无法借由新增路径重绘屏幕。

## 风险

终端只有一个视口，本项新增的每个指示器都在与对话记录争夺行数。小尺寸终端是使设计保持诚实的约束：经过压力测试的 20x5 情形必须保持可用，这意味着每项新增都需要一条降级规则，而不是假定一个最小宽度。

以 Web 插件集合作为清单，也就引入了 Web 界面自身关于什么值得常驻元素的判断。其中一些在终端会是错的：终端的注意力更稀缺且没有余光，某项能力在 Web 上呈现为常驻卡片，在这里可能应当仅由命令触发，而这一判断属于实现它的那次变更。

第 C 层大到「完成 A、B 两层后就停下」是一个正当结果。把其余部分记录为 `dsh-tui` README 中的推迟工作，好过一个半成品的会话切换器。
