# Agent Note：JSON-RPC SDK 协议的 `approval/request`

Status: implemented

[English](2026-08-19-sdk-approval-request.md) | 中文

## 问题

在 [`session/steer`](2026-08-19-sdk-session-steer.md) 之后，JSON-RPC SDK 协议已经能够启动、调整与停止工作，但请求审批（approval）的组合仍会在每个问题上以失败关闭收场：服务器没有注册任何 `approval/request` 应答者，审批 waterfall 落到失败关闭的默认值，工具调用以「no approval channel is available」拒绝。两个交互表面都已能应答——TUI 把问题做成面板（[终端审批](../../../../packages/ui/tui/src/approval.ts)），ACP 把它转发为 `session/request_permission`（[ACP 桥](../../../../packages/acp/acp/src/index.ts)），web BFF 以带应答端点的 mux 帧承载它。传输层的反向请求能力两端都存在，但没有任何东西使用它；协议 README 把它记录为留给审批的未使用功能。

## 决定

服务器为其自有 agent 应答 `approval/request` waterfall，并把每个问题作为协议中唯一的 server→client JSON-RPC 请求（方法 `approval/request`）转发给协议客户端。参数携带审计事实——`sessionId`、`toolName`、可选的 `callId` 与 `reason`——结果为 `{ outcome }`，`'allowed-once'` 是唯一授权。问题不需要协议级关联 id：JSON-RPC 请求 id 配对提问与回答，而持久审计对（`approval/asked`/`approval/decided`）本就随每个客户端可见的 `session.event` 流送达。

失败关闭按 seam 的定义分层：客户端回答不是唯一授权、以及畸形回答，在应答者层映射为 `'rejected'`；错误响应、传输丢失与未回答的问题使应答者拒绝，由审批服务的容错结算为 `'unavailable'`；被中止的工具调用经请求的 abort 信号撤回问题（`'cancelled'`）。组合决定审批是否存在：服务器的应答者无条件注册，但只有审批服务分发 waterfall 时才会触发，因此没有 `dsh-user-approval` 的部署保持执行器的降级拒绝，有它的部署获得经协议传递的决定。

TypeScript 客户端在协议层安装 `HarnessClient.onApprovalRequest(handler)`，在高层构造上提供 `DeepSeekHarnessOptions.onApproval`（握手失败重试经新客户端保留处理器）。没有处理器时传输层应答 `-32603`，运行时以失败关闭收场——未回答的问题是被拒绝的问题，绝不是悬挂。Python SDK 的应答接口已存在；其审批接线随其自身改动到来。

## 考虑过的替代方案

- **通知 + 客户端→服务端应答方法（api-proxy 形状）。** web BFF 使用 `approval/requested` 通知加应答端点，因为 HTTP mux 无法保持请求开启。JSON-RPC 传输是双向的且内建关联，pending registry、重放 id 与第二个方法只会重新实现请求/响应对本已提供的东西。BFF 仍是无法反向请求的传输的参考。
- **复用 ACP 的 `session/request_permission`。** 那套词汇属于 ACP 协议；在 SDK 协议内发明 ACP 形状的方法会耦合两个契约。harness 原生的 `ApprovalOutcome` 词汇（`allowed-once` 唯一授权）正是 waterfall 已经在说的。
- **让客户端可选择 `cancelled`/`unavailable`。** 这些结果归 seam 自己的边缘所有——信号中止与容错——而不是应答的客户端。想拒绝的客户端回答 `'rejected'`；允许它伪造 `'cancelled'` 会污染审计词汇。
- **在服务器插件内挂载审批服务。** 能力组合属于外围 `cordis.yml`（仓库的长期规则）；服务器只为其自有 agent 应答。`examples/jsonrpc-agent/approval.cordis.yml` 展示了这个组合。
- **服务器端的逐问题超时。** 提问的边缘已拥有时序：工具执行器的 abort 信号在轮次被取消时撤回问题，永不回答的客户端让工具调用悬挂的时长正好由工具自身的超时决定。再叠加一个服务器计时器会与两者竞争。

## 验证

- 真实运行时上的 `approval` 快照场景：Claude Code `PreToolUse` hook 把编排的 bash 调用变成 `ask`，协议客户端回答 `'allowed-once'`，会话 fixture 钉住完整序列——`hook/invoked`、`hook/result` ask、`approval/asked`、`approval/decided` allowed-once、获准的工具结果与完成的轮次——外加通知流与客户端处理器收到的参数。
- 服务器包测试：自有 agent 的问题携带审计事实到达传输层；非授权回答与客户端错误经映射的结果以失败关闭收场；外来 agent 的问题被委派（`next()`）。
- stdio plugin-apply 测试驱动真实 `ApprovalService` 穿过挂载的插件：问题作为 server→client 帧跨越协议，响应以两种方式（授权与拒绝）结算决定。
- 客户端包测试：处理器原样在协议上应答；没有处理器时运行时的问题得到错误响应（由 fake runtime 记录）。
- 既有客户端不受影响：组合不提问就不会发送任何审批问题，完整的 SDK 与快照测试套件保持通过。

## 后果

- 协议现在恰好定义一个 server→client 请求；再加一个是契约变更而非传输变更（传输层一直支持它们）。
- 拒绝安装处理器的客户端会把审批默默转换为拒绝；组合审批的部署必须同时组合一个会应答的客户端，这一点写在服务器 README 中。
- 在 Python SDK 接好其应答接口之前，两个 SDK 在审批应答上存在分歧；差距继续记录在 README 的已知限制中。
- 协议的交互面——prompt、steer、interrupt、approval——就此闭合；剩余缺口（逐会话关闭、逐提示词结果）记录在协议 README 的已知限制中。
