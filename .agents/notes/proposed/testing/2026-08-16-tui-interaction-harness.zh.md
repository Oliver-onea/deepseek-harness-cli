# Agent Note: 可复用的基于 PTY 的终端交互测试 harness

Status: proposed

[English](2026-08-16-tui-interaction-harness.md) | 中文

## 问题

`dsh --profile tui` 是随产品发布的终端入口。任何会改变其绘制内容或按键响应的产品用户可见改动，都需要一个无密钥、确定性、可重放的验收测试。`packages/ui/tui/tests/pty-boot.spec.ts` 已经通过真正的 PTY 证明了一条 happy path，但它是专用的：每个新的交互功能都得重新发明 PTY 驱动、屏幕重建和时序控制。

目前没有一个可复用的 harness，让测试作者能够表达“启动终端、输入这段文字、按这个键、断言屏幕包含这段内容”。

## 提案

在 `apps/cli/tests/tui-interaction.harness.ts` 下新增一个可复用的 PTY harness。它通过 `dsh` 源码启动器启动真实随产品发布的终端 profile，对接现有的无密钥 mock 模型，重放脚本化的按键序列，并对渲染后的屏幕进行断言。

### API

`createTuiHarness({ baseUrl })` 返回：

- `type(text)` —— 发送字面文本，不提交。
- `key(name)` —— 发送命名按键（`enter`、`esc`、`tab`、`backspace`、`up`、`down`、`left`、`right`、`ctrl+c`、`ctrl+r`、`ctrl+o`、`space`、`delete`、`home`、`end`、`pageup`、`pagedown`）。
- `submit(line)` —— 输入一行并按下回车。
- `waitFor(text, timeoutMs?)` —— 一旦纯文本屏幕包含 `text` 就 resolve，否则在截止时间 reject。
- `snapshot()` —— 纯文本渲染后的屏幕。
- `ansiSnapshot()` —— 保留给需要感知 ANSI 的 snapshot；当前回退到纯文本。
- `exit()` —— 发送 `/exit` 并返回进程退出码。
- `dispose()` —— 结束进程并删除临时 `DSH_HOME`。

harness 负责 PTY 几何尺寸（`cols`/`rows`）和每轮超时；调用方只需传入 mock 服务器 URL 和脚本。

### 时序策略

harness 等待可观察的屏幕状态，而不是挂墙钟睡眠。每次 `waitFor` 都订阅 PTY 数据流，在每个数据块后重新渲染屏幕，并在谓词匹配的瞬间 resolve。这消除了 PTY 测试中最主要的 flake 来源。

### 环境隔离

子 PTY 进程使用显式环境，不继承父 shell 的 `FORCE_COLOR` 或 `NO_COLOR`。这些变量会改变 pi-tui 输出，并且当两者同时设置时，Node 会打印一条污染 stderr 与 snapshot 的警告。

### 屏幕渲染器

harness 包含一个最小化的 VT100/ANSI 仿真器，从字节流重建终端网格。它处理光标定位、擦除显示/行、回车、换行、退格、制表符和多字节 UTF-8。它在 `snapshot()` 中剥离 SGR 属性，使测试断言的是内容而非颜色。

### 归一化

由于 harness 断言的是实时屏幕状态而不是已检入的 snapshot，主要归一化都在内部完成：

- ANSI 控制序列被解释执行，而不是事后剥离，因此光标定位和清屏是准确的。
- 每行尾部空白被移除，避免空网格单元膨胀 snapshot。
- `DSH_HOME` 是 harness 创建并删除的临时目录，因此绝对路径不会进入断言。
- 会话 ID 在临时 home 内部生成，且在当前用例中不会渲染到屏幕上；如果未来用例需要快照持久化输出，harness 将在比较前归一化 UUID 和临时路径。

### 进程模型

该 spec 被加入 `vitest.config.ts` 的 `processBoundTests` 项目，使其在独立进程中运行，与线程安全的单元测试以及现有的 `packages/ui/tui/tests/pty-boot.spec.ts` PTY 用例隔离开。`knip.json` 将 `tests/**/*.harness.ts` 注册为入口，因此导出的 harness API 常量不会被报告为未使用。

## 考虑过的替代方案

- **把 `node-pty`  plumbing 复制到每个新测试里** —— 不予采纳：它会重复同样的 spawn、清理和字节解析代码，而且时序 bug 无法在一处修复。
- **对原始 PTY 字节流做 snapshot** —— 不予采纳：光标移动、颜色序列和部分重绘会让字节级比较在多次运行和终端尺寸之间不稳定。先重建网格能得到稳定的内容视图。
- **通过管道驱动终端** —— 不予采纳：`dsh-tui` 要求 stdin 和 stdout 都是 TTY，否则会拒绝启动。管道无法证明终端接管，而这正是本层测试的核心目的。
- **使用完整的终端仿真器库** —— 不予采纳：pi-tui 发出的序列是一个小而稳定的子集；手写渲染器让 harness 不引入新依赖，也避免把浏览器级别的解析器拖进 CLI 测试。

## 验收标准

- 测试作者无需编写 PTY plumbing，就能表达按键脚本并对渲染后的屏幕内容进行断言。
- 两个证明用例针对当前终端行为无密钥通过。
- 连续运行十次均通过，无 flake。
- `pnpm run typecheck`、`pnpm run lint` 和 `pnpm run doc-sync` 保持通过。
- API 支持 Tier B 菜单用例：输入 `/`、等待菜单出现、按 `down`/`enter`、断言菜单关闭。

## 后果

`apps/cli/tests/tui-interaction.harness.ts` 成为按键驱动终端验收的归属地。新的终端交互功能在那里添加用例，而不是重新发明 PTY 驱动。harness 被限制在 `apps/cli/tests/` 内，不改动 `packages/ui/tui/`，因此 Tier B 分支可以在无需协调 harness 内部实现的情况下添加其菜单用例。

## 风险

- 屏幕仿真器是刻意最小化的。如果 pi-tui 开始发送它无法理解的序列，渲染屏幕可能会漂移。风险可控，因为只有 pi-tui 和 `@deepseek-ai/dsh-tui` 会发出控制序列，且当前布局使用的序列是稳定的。
- PTY 测试比基于管道的测试慢。它们被限制在唯一需要 PTY 的主题上。
