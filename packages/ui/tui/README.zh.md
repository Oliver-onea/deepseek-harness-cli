# `@deepseek-ai/dsh-tui`

[English](README.md) | 中文

全屏终端前门。它在备用屏幕中渲染一个活跃 agent 的会话并接管终端输入；agent 生命周期、会话持久化、工具执行以及面向模型的提问工具仍是独立的组合条目。

该插件要求 stdin 与 stdout 都是 TTY，否则在挂载时抛错，而不是退化为行式输出：静默回退会掩盖部署错误并改变交互语义。管道与自动化请使用[一次性 headless 应用](../../bundle/headless/README.md)、[ACP](../../acp/acp/README.md) 或 [JSON-RPC](../../sdk/server/README.md)。

随产品发布的组合是 [`dsh-tui-app`](../../bundle/tui-app/README.md)，即 `dsh` 与 `dsh --profile tui` 背后的 bundle。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `session` | 必填 | 该终端驱动的 agent 的确切 `SessionId`，由宿主创建时给出。 |
| `agentWaitTimeoutMs` | `30000` | 等待该 agent 的最长时间；超时会在普通终端拒绝启动。 |
| `color` | `true` | 是否输出 SGR 序列；`false` 以相同布局无样式渲染。 |
| `headLines` | `8` | 折叠工具卡片正文时保留的开头行数。 |
| `tailLines` | `4` | 折叠工具卡片正文时保留的结尾行数。 |
| `showReasoning` | `false` | 推理内容初始是否可见；终端控制键可随时切换。 |
| `task` | — | 屏幕就绪后提交的首个提示，用于 `dsh "<task>"`。 |

插件会在 `agentWaitTimeoutMs` 限制内等待携带 `session` 的 agent，并且只在该 agent 存在之后才进入全屏模式。因此，缺失的 agent 会在普通终端上成为启动拒绝，而不是无限等待或藏在备用屏幕后面的诊断。它在该 agent 上安装 [`installModelSelection`](../../core/agent/README.md)，用于填充 persona 的 `{{provider}}`/`{{model}}` 变量并路由每次请求。

## 它绘制什么

对话记录由**追加来源的会话日志**折叠而成，而非来自模型可见表面，因此恢复的会话保留读者已经看过的每条消息，被压缩的区间也仍可读地留在其标记之后。它渲染人类回合、以 Markdown 呈现的助手文本、推理内容（默认隐藏）、工具卡片，以及回合结束、命令结算和压缩的单行提示。渲染结果按条目缓存，仅在内容或宽度变化时失效，因此重绘长对话只花费真正变动的条目。

工具卡片来自每个工具自己的 `presentCall`/`presentResult`（[渲染意图](../../core/tools/README.md)）：terminal、diff、read、search 与 web 卡片各有终端形态，本渲染器不认识的卡片形态回退到面向模型的结果。工具改变它在这里的呈现方式靠改自己的 presenter，而不是在本包中加分支。

底栏报告运行状态、请求实际使用的路由（来自最新的 `request/context`）、来自 [`ctx.tokenMeter`](../../llm/token-meter/README.md) 的上下文占用、最新的 `todo/write` 计划、收件箱排队深度，以及当前有效的控制键。

## 终端所有权

到达 pi-tui 或窗格标题的每个字符串都先经过 `displayText()`：它折叠回车、展开制表符，并把其他所有 C0/DEL/C1 控制字符渲染为可见的 `\xNN` 转义。只有本包与 pi-tui 会产生 ANSI 控制序列，因此不受信任的工具输出或模型文本无法重绘屏幕、移动光标或设置窗格标题。

调色板只使用标准 16 色 ANSI 前景色与 SGR 属性，正文与背景保持终端默认值，因此宿主终端的浅色或深色主题会重映射整个界面；选中态使用反显。本包没有自己的主题设置。

## 控制键

| 按键 | 效果 |
|---|---|
| `enter` | 提交：已解析的斜杠命令经 [`ctx.commands`](../../interaction/commands/README.md) 执行；其余内容送达 agent —— 空闲时开启后续回合，运行中作为 steering。 |
| `esc` | 取消正在运行的回合。 |
| `ctrl+c` | 取消正在运行的回合；无可取消时离开会话。 |
| `ctrl+r` | 显示或隐藏推理内容。 |
| `ctrl+o` | 展开或折叠所有工具卡片正文。 |
| `/exit`、`/quit` | 离开：取消任何回合，等待 agent 静默以便会话落盘，然后退出。 |

## 交互

插件注册唯一的 `ctx.userQuestions` 提供者，并**仅为自己的 agent** 应答 `approval/request`，其他 agent 的提问交由调用链的其余部分处理。两者都表现为对话之上的同一个键盘面板：带编号的选项、方向键或数字选择、`space` 切换多选、`tab` 改为输入自由文本、`enter` 作答、`esc` 撤销。被撤销或被收回的审批结算为 `cancelled`，所有调用方对此都按拒绝处理。

## Model Experience

无：本包负责渲染输出与收集输入，它提交的是普通用户消息，而 persona、工具与提示分节属于它周围的组合。

#### KV Cache effect

无直接失效。安装的模型选择在会话生命周期内固定，除非组合方改变它，因此请求前缀保持稳定。

## Known Limitations and Deferred Work

- **一个终端一个 agent** —— 插件驱动 `session` 指定的单个会话；终端内没有会话切换器，第二次挂载会争抢同一块屏幕。
- **尚无终端模型选择器** —— 本包安装的模型选择引用正是选择器该写入的位置，但目前没有命令暴露它；启动时的 `--model`/`--provider` 是唯一的选择方式。
- **流式粒度取决于日志** —— 对话记录跟随 `assistant/chunk` 事件，因此不记录 chunk 的组合会在每步消息提交时才绘制该步文本。
- **不渲染图片** —— pi-tui 可在支持的终端中内联放置图片，但附件块目前不产生任何终端输出。
