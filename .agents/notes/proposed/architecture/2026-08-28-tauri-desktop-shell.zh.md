# Agent Note: 覆盖 web 前端的 Tauri 桌面外壳

Status: proposed

[English](2026-08-28-tauri-desktop-shell.md) | 中文

## 问题

`dsh --profile web` 通过 HTTP 提供已构建的前端并打印一行 URL：使用产品意味着打开浏览器，并保持启动它的终端不退出。仓库已经提供终端界面（`dsh --profile tui`）与浏览器界面，但对于是否应存在桌面界面、它应当拥有什么、以及它与前两者的关系，尚无决定。

## 提案

新增一个 Tauri 外壳，在原生 WebView 中承载已构建的 `apps/web`，并拥有本地 harness 进程，使启动应用成为一个动作，关闭窗口即结束该次运行。前端不重写也不分叉：外壳是覆盖在 `@deepseek-ai/dsh-client-web` 之上的交付界面，与 `apps/web` 对它的关系相同。

### web 界面当前拥有什么

`@deepseek-ai/dsh-web-app`（[packages/bundle/web-app](../../../../packages/bundle/web-app)）将已构建的 `apps/web` dist 作为 workspace 知识而非用户配置解析出来，把它作为 `frontend-static` 兜底属主挂载到 `webServer` 上，打印 URL 行，注册 `app:web-surface` 提示词段落与 shell 可见的 `DSH_WEB_URL`，并携带本次调用的 `--trusted-host` 授权主机。`PROFILE_TEMPLATES.web` 将 `@deepseek-ai/dsh-base` 与该 bundle 组合；`headless` 在同一对之上再加 `@deepseek-ai/dsh-headless`。

### 原生代码的既有先例

`native/landlock-run/` 是位于根 pnpm workspace 与 lockfile 内的 Rust workspace，以入口包加各平台包的形式发布，平台包由 npm `optionalDependencies` 持有，`Landlock Run` 与 `Landlock Run Release` 两个工作流拥有构建、逐架构测试与发布。Tauri crate 沿用这一落位与发布先例，而不是为原生代码引入第二套约定。

### 待定决策

1. **crate 落位。** 放在 `native/` 之下还是新开根目录，以及它与根 pnpm workspace、lockfile 和 TypeScript face 配置的关系。
2. **进程归属。** 外壳以 Tauri sidecar 方式拉起 `dsh --profile web`，还是连接到用户已自行启动的服务器。采用 sidecar 会使外壳成为进程监管者，其生命周期、取消与拆除遵循 [docs/defensive-patterns.md](../../../../docs/defensive-patterns.md) 及「一个异步操作对应一个生命周期控制者」规则。
3. **信任。** 桌面启动场景下 `--trusted-host` 信任栅栏、绑定地址与任何凭据如何取值。本地交付不构成静默放宽栅栏的理由，缺失或含糊的取值在最早可解析处 fail loud。
4. **模型可见面。** `app:web-surface` 与 `DSH_WEB_URL` 是写给模型看的，用于在浏览器中为它定向。在桌面外壳下这段文字可能不再为真；不为真之处，外壳注册自己的界面段落，而不是复用一段不准确的描述，且这些段落始终可从会话日志重建。
5. **组合方式。** 是新增 `desktop` profile 及其自己的 bundle patch 层，还是复用 `web` profile 并由外壳提供取值。随部署而变的选择是可从 `cordis.yml` 设置的、经校验的 `Config` 字段，而不是插件中的常量。

## 备选方案

**Electron。** 包装 React 前端时 Electron 路径更成熟，且不要求 Rust 知识；标签体系本就把浏览器与 Electron 交付视为同一个 `area/web` 域，因此它在选择范围内。它输在产物体积——每个应用自带一份 Chromium——以及与仓库的契合度：本仓库已经跨架构构建、测试并发布 Rust，Tauri crate 复用已存在的机制，而不是新增第二套打包栈。

**启动服务器并打开默认浏览器的脚本。** 成本低得多，不需要原生代码，也能实现一个动作启动。它输在没有给产品带来窗口身份、生命周期归属与单一退出路径，并且无法回答决策 4：界面仍是浏览器标签页，模型可见的定向文字无需改动，桌面这个问题被推迟而非解决。

**把前端重写为原生 UI。** 丢弃一个可用的客户端，并重复它已覆盖的每个界面，相较于在 WebView 中打开同样的页面没有用户可见收益。终端场景已由 TUI 界面覆盖。

**置于根 pnpm workspace 之外的 Rust crate。** 把原生构建与 Node 工具链隔离开，代价是第二份 lockfile、第二种 CI 形态，以及外壳与它所启动的 harness 之间的版本漂移。`landlock-run` 先例选择了相反的取舍，也正是本仓库已在维护的那一套。

## 验收标准

- 构建产出可运行的桌面应用，打开即是现有前端，行为与 `dsh --profile web` 一致。
- 上述五项待定决策得到定论并记录为决策，本记录在落地该工作的改动中移入 `implemented/architecture/`。
- 仓库门禁在 macOS 上通过。该改动未能验证的平台在 PR 中写明，而不是报告为通过。
- 用户可见的 GUI 变化附带从真实服务器与模型流程录制的 GIF，遵循 [docs/testing.md](../../../../docs/testing.md)。

## 风险

- WebView 工具链按平台扩大构建矩阵。Linux 需要 `webkit2gtk-4.1`，而本仓库 agent（智能体）会话所用的云端容器没有它，因此 Linux 构建无法在那里验证，该工作属于开发机。
- sidecar 进程可能在外壳异常退出后继续存活。孤儿进程清理是决策 2 的设计义务，而非后续事项。
- 覆盖率门禁是对 `packages/*/*/src` 的每文件 100%，只覆盖 TypeScript。Rust 需要自己的测试信号，或在属主 README 的 `## Known Limitations and Deferred Work` 下写明该缺口。
- 桌面外壳容易在一个比浏览器栅栏所假设的更友好的界面下，交付出 harness 凭据与主机访问权限。决策 3 是对应的控制手段，它在外壳发布之前而非之后定下。
