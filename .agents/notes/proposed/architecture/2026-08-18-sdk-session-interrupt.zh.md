# Agent Note: JSON-RPC SDK 协议的 `session/interrupt`

Status: proposed

[English](2026-08-18-sdk-session-interrupt.md) | 中文

## Problem

JSON-RPC SDK 协议(`dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` / `dsh-sdk-client`)恰好只暴露三个请求——`initialize`、`session/prompt`、`shutdown`——因此进程外客户端可以启动 agent 工作,却无法停止它。服务器为其创建的每个会话都持有 `AgentHandle`,而 `Agent.cancel(cause, options)` 已经定义了中断所需的语义:中止活动轮次,并清除已排队与 steering 工作,除非 `keepInbox` 保留它们([显式轮次取消](../../implemented/architecture/2026-07-16-explicit-turn-cancellation.md))。另外两个交互界面都能停止轮次——TUI 通过 Esc,ACP 通过 `session/cancel`——而 SDK 客户端只能等待轮次结束或杀掉整个运行时。

决策中涉及排队工作的那一半,是 wire 设计者不能留作隐式的部分。`Agent.cancel` 默认清空收件箱;Web UI 则刻意保留它([web stop preserves queue](../../implemented/bug-fix/2026-07-31-web-stop-preserves-queue.md)),且被保留的工作保持停放,直到后续唤醒 prompt 认领它([cancel convergence wake latch](../../implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.md))。一个隐藏此选择的 wire 方法会把单一策略强加给所有客户端。

## Proposal

新增第四个请求 `session/interrupt`,形状仿照 `session/prompt`:params 携带目标 `sessionId`,result 是空的接受回执,进度通过既有的 `session.event` / `session.status` 通知观察,而不是通过响应。服务器在 wire 边界校验 params,将会话 id 解析到其活跃记录——未知 id 会响亮失败,返回点名该 id 的 JSON-RPC 错误;与 `session/prompt` 不同,interrupt 绝不创建会话——然后对它已持有的 agent 调用 `agent.cancel({ kind: 'user' }, { keepInbox })`。中断空闲会话是 `Agent.cancel` 文档约定的无操作,不会预置任何后续工作。

`keepInbox` 是可选布尔值,默认为 `false`:wire 镜像 `Agent.cancel` 自身的默认值,而不是发明新策略,其原则是裸露的"interrupt"意味着*停止一切*,保留队列才是客户端明确陈述的刻意选择。被保留的工作是停放的,不会自动运行;下一个唤醒 prompt 会将它作为自己的轮次认领。

TypeScript 客户端在协议层增加 `HarnessClient.interrupt(sessionId, options?)`,在按会话句柄上增加 `HarnessSession.interrupt(options?)`,因为会话句柄本就是客户端路由 prompt 的位置。`DeepSeekHarness` 本身不增加任何东西:`run()` 拥有自己的活动区间,而 harness 级的中断没有可路由的会话。Python SDK 是同一协议上的设计孪生,将在其自己的变更中获得 interrupt;在此之前,该对等差距记录在 SDK README 的 Known Limitations 中。

## Wire contract

`session/interrupt` params:`sessionId: string`(必需;非字符串在触及任何会话状态之前即被拒绝)与 `keepInbox?: boolean`(出现但非布尔同样被拒绝)。Result:`{}`——仅表示接受,因此响应绝不会与中止的收敛竞争。错误情形:未知会话 id 产生点名该 id 的 JSON-RPC 错误;畸形 params 产生以 internal-error 响应呈现的 `TypeError`。wire 上的 cause 恒为 `{ kind: 'user' }`,与 ACP 的 `session/cancel` 一致。

## Alternatives considered

- **用即发即弃的通知而非请求。** ACP 的 `session/cancel` 是通知,但 ACP 配以按轮次返回的 prompt 请求。此处 `session/prompt` 是其响应确认接受的请求,interrupt 也需要同一通道来报告未知会话 id——通知无法失败。
- **像 `session/prompt` 那样懒创建会话。** 对新 id 发起 prompt 是正常工作流;中断一个从未存在过的会话几乎必然是客户端 bug(过期或打错的 id),静默创建空会话会掩盖它。在最早可解析点响亮失败。
- **默认 `keepInbox: true`。** Web UI 的停止保留队列默认值,反映的是期望草稿存留的交互式人类用户;发出 interrupt 的程序化客户端更常意味着*彻底放弃这项工作*。镜像 `Agent.cancel` 的默认值让 wire 不携带策略,并让需要保留的客户端明确声明。
- **在 result 中报告是否有轮次在运行。** 该布尔值会与中止的收敛竞争并诱导轮询;通知流才是权威的观察通道,接受回执保持响应语义稳定。
- **阻塞响应直到轮次收敛。** 这会把 wire 延迟耦合到 loop 内部(工具拆除、流中止传播),却不会给客户端带来好处——关心收敛的客户端本就订阅了 `session.status`。
- **`DeepSeekHarness.run` 级别的取消句柄。** `run()` 在会话下一次空闲时结算并拥有自己的通知订阅;给它叠加按 run 的取消会重复会话句柄已提供的路由。`HarnessSession.interrupt` 以单一明确目标覆盖同样的会话。

## Acceptance criteria

- 客户端中断运行中的轮次并观察到它停止(`turn/end` 以 cause `{ kind: 'user' }` 中止,随后 `session.status` 空闲)——由经真实运行时的 `interrupt` 快照场景钉住。
- 排队工作行为在 wire 上显式、在三份 SDK README 中均有文档,并双向测试:默认值丢弃已排队 prompt;`keepInbox: true` 将其停放,由后续唤醒 prompt 认领(`interrupt-keep-inbox` 快照)。
- 中断空闲会话是无操作且不预置后续工作;未知会话 id 产生点名它的 JSON-RPC 错误;畸形 params 在 wire 边界拒绝而不触及 agent——均由 server 与 client 包测试覆盖。
- 现有客户端不受影响:`initialize`、`session/prompt`、`shutdown` 行为与之前完全一致,从不调用 `session/interrupt` 的客户端看不到任何变化(SDK 与快照全套件保持绿色)。

## Risks

- 停放队列语义(被保留的工作等待唤醒 prompt,而非自行恢复)可能让期待 Web 式立即继续的客户端意外;wire 文档与两份快照都明确陈述了它,而改变它将是 agent-loop 的决策,不是 SDK 的。
- 在 Python SDK 获得自己的 interrupt 之前,两个 SDK 在一个协议方法上存在分歧;该差距记录在 README 中,以免 Python 用户对缺失的方法感到意外。
- 审批请求与 `turn/steer` 仍是另外两个交互缺口;本设计既不解决也不阻碍它们——未来的 steer 请求会经由相同的按会话记录与相同的接受回执形状路由。
