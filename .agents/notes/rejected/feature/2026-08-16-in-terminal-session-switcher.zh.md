# Agent Note: 终端内会话切换器

Status: rejected — 单会话是 tui-app bundle 的构图契约，切换器的代价是把 Web 面的按会话 preset 迁移在终端侧重做一遍，而 `--resume` 已经提供了跨进程的连续性。

[English](2026-08-16-in-terminal-session-switcher.md) | 中文

## 问题

`dsh-tui` 只驱动其 `session` 配置所指定的单个会话，[其 README](../../../../packages/ui/tui/README.md) 在 Known Limitations 中记录了后果：终端内没有会话切换器，第二次挂载会争抢同一块屏幕。跑两个对话意味着两个进程，各自一块屏幕。

Web 面没有这个限制。[`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md) 列出会话并提供新建会话操作，因此终端读起来像是更差的那一面。[终端与 Web 对齐计划](../../implemented/feature/2026-08-14-terminal-web-parity.md)把会话切换器列入第 C 层，正是因为它关闭一条已记录的差距。

## 提案

给终端一个进程内会话切换器：列出活跃与已持久化的会话，用一个按键或命令打开，并可在不离开进程的前提下在对话之间移动——即 Web 侧边栏的终端形态。

## 曾考虑的替代方案

**每个对话一个进程，也就是当前已发布的行为。** 第二个终端标签页的代价只是一个标签页。`dsh --resume <session>` 已经承载跨进程的连续性：启动提供者恢复已持久化的会话，对话记录、日志中记录的模型路线、以及中断轮次的恢复全都幸存。本次否决正是建立在这个替代方案之上。

**启动期的 resume 选择器。** 当前安排中真正的痛点不是切换，而是**发现**会话 id——读者必须已经知道 id 才能传给 `--resume`，仓库自己的测试也要从磁盘上反查 id。启动期选择器以切换器的一小部分成本消除这个痛点，且完全不触动单 agent 构图。这是推荐的后续项，不在本次否决范围内；它已作为[启动时的会话恢复选择器](../../implemented/feature/2026-08-18-tui-launch-resume-picker.md)落地。

## 否决理由

单会话不是 UI 层的疏漏，而是 bundle 的构图契约，三处明文写着：

- [`dsh-tui-app`](../../../../packages/bundle/tui-app/cordis.patch.yml) 组合**恰好一个** agent——`agents: !!js "[ctx.tuiStartup.agent]"`，其上方注释写明该 bundle 在启动时组合恰好一个 agent，且由启动提供者决定它是新建还是恢复。
- [`dsh-base`](../../../../packages/bundle/base/cordis.patch.yml) 刻意把 `agent-loop` 留成 `agents: []`，注释为「The base stays empty; raw overlays may create agents, while Web creates sessions on client request.」按需建会话这条路径已经存在，只有 Web 面走了它。
- [`dsh-web-app`](../../../../packages/bundle/web-app/cordis.patch.yml) 在把 agent 平面移到 preset 背后的位置直接说明了这笔交易：「The base keeps them for the TUI, which is single-session and composes its agent process-wide; the Web surface disables them here and lets each session mount a preset instead.」

Web 面之所以能有按会话的 agent，是因为它禁用了每一行「构成单个 agent 所贡献之物」的 host 行——它的工具、它的提示词分节、它的委派后端——再由每个会话通过 preset 重新挂载。因此终端切换器的代价不是一块面板，而是同一次迁移在终端侧重做一遍，把进程级的工具、提示词与委派作用域转换为按会话作用域。

这是一次构图重写，相对于「第二个终端标签页」的收益很小，并且会推翻 [`dsh-tui-app`](../../../../packages/bundle/tui-app/README.md) 自陈的设计属性：它是 Web bundle 的反面，把 base 的那些行保留为其单个 agent 自己的。

## 否决的后果

终端维持每进程一个对话，该条 Known Limitation 作为现状事实留在 `dsh-tui` README 中，而不是待办工作。

下一轮对齐工作中有两项比切换器更值得做，两者都记录在同一份 README 里：

- **Effort 选择。** `/model` 只套用所选模型的默认 reasoning effort，不提供 effort 菜单，而 Web composer 提供 Model 与 Effort 两级。面板、模型选择 ref 与 `reasoningEffort` 字段都已就位，因此这是一个小改动即可关闭的对齐缺口。
- **启动期 resume 选择器**，如上所述 —— [已实现](../../implemented/feature/2026-08-18-tui-launch-resume-picker.md)。

## 重新引入的条件

若终端构图因其他原因转向按会话 preset，则重新考虑——届时昂贵的那一半已经付过，切换器将退化为既有能力之上的一块面板。
