# Agent Note: Python SDK 交互式功能对等

Status: proposed

[English](2026-08-26-python-sdk-interactive-parity.md) | 中文

## Problem

Python SDK 是 TypeScript SDK 客户端的设计孪生体，但在三个交互式方法以及 shutdown 上落后了。交互式客户端所需的一切功能——引导运行中的 turn、中断它、回答审批问题——在 TypeScript 中可用，但在 Python 中不可用。这一差距使 Python 用户无法构建交互式或需要审批的工作流。

## Proposal

向 Python 的 `HarnessClient` 添加四个协议方法，并在高层 `Session` 类上暴露 steering 和 interrupt。

1. **`session_steer(session_id, content_blocks)`** — 镜像 `client.ts:346`。发送 `session/steer`，验证响应是否携带 `messageId`，如果没有则抛出 `SdkProtocolError`。

2. **`session_interrupt(session_id, keep_inbox=False)`** — 镜像 TypeScript 的 `interrupt` 方法。仅在 `True` 时发送 `keepInbox`，保留协议默认清除排队工作的行为。验证结果为 JSON 对象。

3. **`shutdown()`** — 发送协议 `shutdown` 请求。`close()` 在传输层关闭前调用 `shutdown()`，与 TypeScript 客户端的行为一致：shutdown 是尽力而为的，dispose 阶梯才是权威的。

4. **`on_approval_request(handler)`** — 注册服务器→客户端 `approval/request` 问题的处理程序。处理程序接收类型化的 `ApprovalRequestParams`，必须返回 `outcome` 在 `{'allowed-once', 'rejected'}` 中的 `ApprovalRequestResult`。未注册处理程序时，运行时的问题会收到错误响应，工具调用以失败关闭。格式错误的参数和未返回决策的处理程序被视为协议错误，与 TypeScript 客户端一致。

高层 `Session` 类新增 `steer(input)` 和 `interrupt(keep_inbox=False)`，使用户持有 `Session` 时无需直接操作底层客户端。

## Alternatives considered

- **仅暴露底层客户端方法，不添加 `Session` 方法：** 被拒绝，因为持有 `Session` 的用户不应为了 steering 或 interrupt 而直接操作底层客户端。TypeScript SDK 的 `Session` 等价物暴露了这些方法；对等性要求相同的便利性。
- **在 `Session` 上添加 `shutdown`：** 被拒绝，因为 shutdown 是运行时级别的行为，而非会话级别的行为。`DeepSeekHarness.close()` 已经拥有运行时生命周期。
- **使用基于回调的审批处理程序替代 `on_approval_request`：** 被拒绝，因为同步 Python SDK 已经使用轮询模型（`next_request`/`respond`）。基于注册的处理程序保持相同模式，同时自动响应，与 TypeScript 客户端的设计一致。
- **将 `keep_inbox` 默认设为 `True`：** 被拒绝，因为协议文档将 `keepInbox` 的默认值定义为省略，这会清除排队工作。保留协议默认值可避免用户期望中断停止一切时的意外。

## Acceptance criteria

- 四个协议方法都有带类型注解、有文档的 Python 接口。
- Python 中 `keep_inbox` 的默认值与协议文档完全一致（`False`，不在 wire 上发送 `keepInbox`）。
- 协议违反路径抛出 `SdkProtocolError` 并已测试。
- 已注册的审批处理程序应答服务器请求；无处理程序的情况不会挂起。
- `uv run --project python/sdk pytest` 通过。
- 双语 README 和 Agent Note 更新通过 `doc-sync`。

## Risks

- 审批处理程序在 reader 线程中运行。慢速处理程序会阻塞 reader 循环并可能延迟其他消息。需要文档说明并建议快速处理程序。
- `_dispatch_server_request` 是新的 wire-path 代码。任何 bug 都可能静默破坏 reader 线程。测试覆盖了三种失败模式（无处理程序、参数格式错误、无决策）。
