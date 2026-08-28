# Agent Note：JSON-RPC SDK 协议的 `session/steer`

Status: implemented

[English](2026-08-19-sdk-session-steer.md) | 中文

## 问题

在 [`session/interrupt`](2026-08-18-sdk-session-interrupt.md) 之后，JSON-RPC SDK 协议能够启动和停止工作，却无法在轮次进行中调整它：`session/prompt` 总是拼入 `next-turn` 收件箱，因此轮次运行期间发出的提示词要等该轮次结束。两个交互表面都已支持 steering（中途引导）——TUI 在会话运行时发送 `agent.steer`（[终端 steering](../../../../packages/ui/tui/README.md)）——而 `Agent.steer` 定义了确切的语义：带唤醒地拼入 `next-step`，运行中的轮次在下一个 step 边界消费该消息，空闲会话则以它开启下一个轮次。有同样需求的 SDK 客户端没有协议方法；它轮次中途唯一的手段就是中止轮次。

## 决定

`session/steer` 的形状仿照 `session/prompt`：参数携带目标 `sessionId` 与 `contentBlocks`，结果为 `{ messageId }`——被拼入的用户消息的持久标识，其 `agent/inbox/spliced` 回执（target `next-step`）与其他事件一样经 `session.event` 流到达。服务器按其存活记录解析会话 id，在执行与 `session/prompt` 相同的存活注册表校验后，对已持有的 agent 调用 `agent.steer`。空闲时的 steer 即 `Agent.steer` 自身的唤醒语义——它开启下一个轮次——因此服务器无需检查状态，协议也不规定策略。

与 `session/prompt` 不同而与 `session/interrupt` 相同：未知会话 id 会响亮失败，而不是惰性创建会话——steering 针对的是运行时已经拥有的工作，过期或误输的 id 是客户端 bug，凭空造出 agent 只会掩盖它。方法名沿用其同族占据的 `session/*` 命名空间；`Agent.steer` 命名底层 seam。

`HarnessClient.steer(sessionId, contentBlocks)` 在协议层镜像 `prompt`，`HarnessSession.steer(input)` 是逐会话句柄捷径（字符串输入规范化为单个文本块）。与 `interrupt` 一样，`DeepSeekHarness` 本身不加方法：不存在可路由的 harness 级会话。Python SDK 将随其自身改动获得该方法；能力差距继续记录在三份 SDK README 的已知限制中。

## 考虑过的替代方案

- **多态的 `followupOrSteer` 提示词。** 用 `mode` 字段重载 `session/prompt` 会把两种不同的投递契约（排队至下一轮次 versus 加入当前轮次）藏在同一个方法后面，使每个客户端的回执处理都变成有条件的。两个名字让收件箱目标成为协议级事实。
- **像 `session/prompt` 那样惰性创建会话。** 对新 id 发提示词是正常工作流（首次接触）；对它 steer 不是——steer 的意义在于影响已在进行的工作，因此未知 id 几乎必然是过期或误输。在最早可解析处以响亮失败，与 `session/interrupt` 一致。
- **拒绝空闲 steer。** `Agent.steer` 已定义空闲行为（唤醒开启下一个轮次），在服务器里重新实现状态闸门会与 agent 自身的转换竞争，又换不来对调用方的任何保护——关心的客户端会先查 `session.status`。
- **报告消息何时被消费。** 消费已被持久记录（消费 step 内的 `user/message`）并作为 `session.event` 流出；更丰富的结果只会把协议时延耦合到循环内部细节，却不产生新事实。接受回执保持响应语义稳定，与 `session/interrupt` 的论证完全一致。

## 验证

- 轮次运行期间发出的 steering 消息加入该轮次：step-2 模型请求携带 steering 文本且轮次只完成一次——由真实运行时上的 `steer` 快照场景钉住，其中编排的 step 1 运行 bash `sleep 1`，使 steer 确定地落在工具执行中途。
- 空闲 steer 开启下一个轮次且其文本到达模型请求——由服务器包测试与 stdio plugin-apply 测试覆盖。
- 未知会话 id 产生指明该 id 的 JSON-RPC 错误；非法参数在协议边界被拒绝，不会到达 agent；steer 绝不创建会话——服务器与客户端包测试。
- 既有客户端不受影响：`initialize`、`session/prompt`、`session/interrupt` 与 `shutdown` 行为与之前完全一致，完整的 SDK 与快照测试套件保持通过。

## 后果

- next-step 的消费顺序遵循 agent 循环的 step 边界，而非相对工具执行的到达顺序；需要在单个 step 内严格排序的客户端应通过自己的协议自行负责。
- 在 Python SDK 获得自己的 steer 之前，两个 SDK 在该协议方法上存在分歧；差距已记录在 README 中，Python 用户不会感到意外。
- 审批请求仍是该协议上最后一个交互缺口；为它预留的 server→client 请求能力不受此变更影响。
