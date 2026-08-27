# ui/ — terminal front doors

English | [中文](README.zh.md)

Interactive human surfaces that own a terminal. A front door here renders one live agent and takes the keyboard; the agent, its session, its tools, and the commands it answers stay separate composition rows, so a deployment swaps the surface without touching the plane below it.

| Package | Role | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | Full-screen terminal conversation over one agent | — (registers the `userQuestions` provider and an `approval/request` answerer) |

The browser half of the product lives in [`client/`](../client/README.md) and [`host/`](../host/README.md); automation surfaces live in [`acp/`](../acp/README.md) and [`sdk/`](../sdk/README.md).
