# Agent Note: 启动时的会话恢复选择器

Status: implemented

[English](2026-08-18-tui-launch-resume-picker.md) | 中文

## Problem

`dsh --resume <session>` 让连续性跨进程保留，但要传入的 id 只能靠人工发现：读者必须已经知道它，而本仓库自己的测试也是靠从磁盘上读出 id。同样能解决这个问题的终端内会话切换器已被否决 —— 它的代价是把 Web 界面的每会话 preset 迁移在终端侧重做一遍 —— 且该否决把启动时选择器列为推荐的后续工作（[否决记录](../../rejected/feature/2026-08-16-in-terminal-session-switcher.md)）。

## Decision

不带会话名的 `dsh --resume` 打开一个列出持久层顶层会话的键盘列表，并恢复选中的那个；`--resume <session>` 保持不变。列表由 [`dsh-tui`](../../../../packages/ui/tui/README.md) 拥有（`resume-picker.ts`）：名册来自 `resumeCandidates(headers)` —— 丢弃子 agent 会话、最新在前、id 打破并列 —— 且每一行都经过 `displayLine()`，因为持久化的元数据是不受信任的文本。选择器在备用屏幕前门之前绘制在普通终端上，且只在列表显示期间持有 stdin，因此启动失败仍能报告给一个普通终端。`esc` 与 `ctrl+c` 都在不恢复也不新建任何东西的情况下退出：启动时没有会丢失的排队工作，而被放弃的选择器绝不能用新会话顶替调用所要求的恢复。

[`tui-startup`](../../../../packages/bundle/tui-app/README.md) 让选中的 id 走与指名恢复完全相同的持久层检查。选择器无法给出目标的一切途径都会在依赖行激活之前拒绝启动 —— 任一流不是 TTY（拒绝消息指出显式形式）、存储无法列出、没有可选项、终端放不下一个候选行，或列表被关闭 —— 因此既不会恢复错会话，也不会凭空新建会话。

### 在拆除时中止一个挂起的选择器

中止不能挂在 `ctx.effect()` 处置器上：vendored Cordis 只在 fiber 的启动回调结束之后才运行其 effect 清理，因此在尚未结束的 `apply` 内注册的处置器永远不会触发，等待它的选择器会让树的拆除死锁，原始模式 stdin 也继续把进程挂住。插件改为在 `internal/plugin` 上观察自身的拆除（`fiber === ctx.fiber && fiber.uid === null`，该事件在拆除开始时、卸载并入进行中的回调之前发出），并从那里中止选择器，在选择器结束后停掉监听。这与 [`lsp-stdio`](../../../../packages/lsp/lsp-stdio/src/index.ts) 取消 setup 的机制相同。

## Alternatives considered

**终端内会话切换器。** 已另行否决且维持原判：单会话是 tui-app bundle 的组合契约，切换器的代价是 Web 界面付过的每会话 preset 迁移（[否决记录](../../rejected/feature/2026-08-16-in-terminal-session-switcher.md)）。

**用 effect 处置器中止。** 在 vendored Cordis 中无法在启动进行期间触发；经验证，当子插件的回调在等待一个只有它自己的处置器才能打开的闸门时，根 `fiber.dispose()` 永远不会结束。`internal/plugin` 的自观察抵达同一次拆除，且不存在原始 stdin 比树活得更久的窗口。

**直接拒绝不带会话名的 `--resume`。** 标志处理最少，但切换器否决所点名的发现痛点 —— 单会话安排唯一真实的代价 —— 依然存在。

## Consequences

终端在不动单 agent 组合的前提下获得了启动时的会话发现：选择器是 `dsh-tui` 的导出、由 `tui-startup` 消费，TTY 闸门、名册读取和组合前拒绝的次序都留在命令行所在的 bundle。选择器没有过滤或搜索（行可滚动；数字可达前九行），记录在 `dsh-tui` README 的限制中。终端内切换器维持否决，[终端与 Web 对齐计划](2026-08-14-terminal-web-parity.md) 的 Tier C 会话列表也保持搁置：启动时选择覆盖的是恢复的发现，不是在活进程内切换。

## Testing

- `packages/ui/tui/tests/resume-picker.spec.ts` 覆盖名册推导、行布局与净化、全部按键路径、重绘/擦除行为、过小拒绝、中止结算，以及 `color` 关闭时布局不变。
- `packages/bundle/tui-app/tests/startup.spec.ts` 驱动真实 cmdline 宿主：选中的 id 与指名恢复完全一致（同一持久层检查）、每条拒绝消息、非 TTY 拒绝，以及拆除中止恢复行模式。测试等待可观察的选择器状态（首次绘制、原始模式开启），而不是假设插件同步启动 —— 仓库级测试不变量宿主会把每个根插件推迟到其就绪链之后，同步断言读到的是尚未绘制的选择器。
- `apps/cli/tests/tui-interaction.spec.ts` 的 PTY 旅程用例覆盖同一 harness home 上的两次启动拾取与 esc 关闭拒绝；`node-pty` 在编写它的沙箱中无法 spawn，因此这两个用例随共享 harness 一并编写，在沙箱之外执行。
