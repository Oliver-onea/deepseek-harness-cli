# DeepSeek Harness Python SDK

[English](README.md) | 中文

用于以子进程方式驱动 DeepSeek Harness 的 Python 包。客户端 SDK 通过 stdio 使用按行分隔的 JSON-RPC 与内置运行时通信。

## 包

| 目录 | 分发名／模块 | 职责 |
|---|---|---|
| [sdk](sdk/README.md) | `deepseek-harness-sdk` / `deepseek_harness` | 高层轮次 API 与低层 JSON-RPC 客户端 |
| [sdk-runtime](sdk-runtime/README.md) | `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | 内置运行时二进制与默认 agent（智能体）配置 |

## 行为

除非调用方选择显式通道，否则 SDK 会启动匹配的内置运行时。客户端选择通道并提供默认配置；运行时本身始终要求显式配置。[SDK 参考](sdk/README.md)和[运行时载体参考](sdk-runtime/README.md)定义完整的运行时选择与配置约定。

## 交互式控制

Python SDK 镜像了 TypeScript 客户端的交互式方法：

- `HarnessClient.session_steer(session_id, content_blocks)` — 对运行中的会话进行 steering。
- `HarnessClient.session_interrupt(session_id, keep_inbox=False)` — 中断会话的活跃 turn。
- `HarnessClient.shutdown()` — 发送协议 shutdown 请求。
- `HarnessClient.on_approval_request(handler)` — 注册服务器→客户端审批问题的处理程序。

高层 `Session` 类也提供了 `steer()` 和 `interrupt()` 以方便使用。

## 贡献者工作流

[Python 贡献者工作流](development.md)介绍运行时产物构建、包验证、源码模式开发和分发。
