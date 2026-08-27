# ui/ — 终端前门

[English](README.md) | 中文

拥有终端的交互式人机界面。这里的前门渲染一个活跃 agent 并接管键盘；agent、它的会话、工具以及它响应的命令仍是独立的组合行，因此部署方可以替换界面而不触碰其下的平面。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`tui/`](tui/README.md) | 基于单个 agent 的全屏终端对话 | —（注册 `userQuestions` 提供者与一个 `approval/request` 应答器） |

产品的浏览器一半位于 [`client/`](../client/README.md) 与 [`host/`](../host/README.md)；自动化界面位于 [`acp/`](../acp/README.md) 与 [`sdk/`](../sdk/README.md)。
