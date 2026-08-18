# Agent Note: 已发布终端交互的无密钥旅程快照

Status: proposed

[English](2026-08-17-tui-journey-snapshots.md) | 中文

## 问题

已发布的 `dsh --profile tui` 增加了三个产品用户可见的交互功能：`/` 命令菜单、`@` 子代理引用菜单和 `/model` 模型选择器。每项功能都有包级单元测试支撑，但 `docs/testing.md` 要求的、能固定用户实际所见内容的组装旅程快照，在每个单独的功能 PR 中都属于范围外。现在缺失的组装覆盖落在 `apps/cli/tests/`。

## 提案

使用 `apps/cli/tests/tui-interaction.harness.ts` 中现有的 PTY harness，在 `apps/cli/tests/tui-interaction.spec.ts` 下新增无密钥、确定性的旅程快照。这些用例启动真实终端 profile、对接无密钥 mock 模型、重放用户会输入的确切按键，并对渲染后的屏幕进行比较。

### 场景

1. **斜杠菜单（`/`）** —— 输入 `/he`，等待实时命令注册表过滤完成，按 `enter`，并对已分发的 `/help` 命令行做快照。
2. **`/help` 文本** —— 提交 `/help` 并对渲染为纯文本的实时注册表做快照，包括命令名、提示与描述。
3. **子代理引用（`@`）** —— 在无模型轮次的情况下确定性地上台一个运行中的子代理子会话，输入 `@`，选中子会话，并对编辑器中的引用做快照。
4. **斜杠菜单中的 skill 来源（`/`）** —— 在无模型轮次的情况下确定性地上台一个用户可调用 skill，输入 `/jou`，等待该 skill 在命令注册表之后出现，按 `enter`，并对生成的用户提示与 mock 回答在 transcript 中的呈现做快照。
5. **`@` 空列表** —— 不带子会话上台 patch 插件，输入 `@`，并对菜单未打开、仅保留 `@` 在输入区的状态做快照。
6. **模型选择器（`/model`）** —— 打开选择器，按 `esc` 取消，再次打开，下移到 `deepseek-official/deepseek-v4-pro`，按 `enter` 应用，并对确认信息做快照。

7. **Effort 层级（`/model`）** — 从路线行下钻到其适配器声明的 effort 层级并应用，快照确认信息。
8. **直接 effort 参数** — `/model <route> <effort>` 不开面板直接选定，并报告钉住的 effort。
9. **拒绝不支持的 effort** — `/model <route> <unknown-effort>` 在选取时失败并列出该路线所声明的项，先前的选择保持不变。
10. **替换通知** — 丢弃已存明确 effort 的模型选取会报告 `was <effort>`，钉住最终采用（而非 carry-forward）的决定。

### 为 `@` 用例上台运行中的子会话

`@` 菜单需要有一个运行中的子代理子会话可供列出。真实的模型轮次会让测试变得非确定性并需要密钥，因此通过一个 fixture 插件（`apps/cli/tests/fixtures/tui-journey/stage-subagent-child.ts`）经 `--patch` 注入：

- 等待终端的 agent 出现。
- 创建一个 live 子会话，设置 `origin: 'subagent'`、`parentSession` 为终端会话、`delegationDepth: 1`。
- 追加一条 `subagent/descriptor`，包含 `mode: 'continuable'`、`provider: 'spawn'` 和 `label: 'journey-child'`。

该子会话 live 在 session store 中，因此 `subagents.listChildren` 会将其作为 `running` 返回，`@` 菜单会列出 `journey-child`。

### 为 `/` skill 用例上台 skill

`/` 菜单需要有一个用户可调用的 skill 可供列出。真实的模型轮次会让测试变得非确定性并需要密钥，因此通过一个 fixture 插件（`apps/cli/tests/fixtures/tui-journey/stage-skill.ts`）经 `--patch` 注入：

- 它使用与子会话 fixture 相同的 `TUI_STARTUP_SERVICE` 模式等待终端的 agent 出现。
- 它通过 `ctx.skills.register` 在全局层注册一个 runtime skill，使 agent 的作用域链能够读取到它。
- 它等待该 skill 能通过 `ctx.skills.list({ scope: agent })` 被观察到，即菜单实际使用的同一条目录路径。

该 skill 是注册表中的真实 skill，因此菜单会在命令注册表之后列出它，并且选中后会将 `/journey-skill` 作为普通提示文本发送给模型。

### Harness 改动

快照需要两处 harness 小改动：

- **UTF-8 解码修复** —— 之前的 Latin1 字节路径会把多字节字符（例如 `/help` 输出中的 em dash）变成空格。harness 现在将 PTY 流按 UTF-8 解码后再送入仿真器。
- **`waitUntil(predicate)`** —— 补充 `waitFor(text)`，便于表达谓词条件，例如“模型选择器已不在屏幕上”。
- **`cancel()`** —— 发送 `ctrl+c` 并返回退出码。`@` 用例在编辑器中留下文本（`@journey-child x`），此时普通 `/exit` 会追加到行尾而非执行命令。无运行轮次时 `ctrl+c` 可干净退出。

### 归一化

快照是终端网格的纯文本渲染。只有真正会变的内容才被归一化：

- 运行轮次页脚中的 **`working <N>s`** 被替换为 `working <N>s`，因为耗时秒数在运行之间变化。其余内容——命令注册表、路由名、模型目录、子会话标签——在无密钥 mock 和默认 100×30 几何下都是确定性的。
- ANSI 序列由仿真器解释执行并从 `snapshot()` 中剥离，因此颜色和光标移动不会影响稳定性。
- 每行尾部空白被移除，避免空网格单元膨胀快照。
- `DSH_HOME` 是 harness 创建并删除的临时目录，因此绝对路径和会话 ID 不会进入断言。

### Flake 证据

新用例连续运行十次：

```sh
env -u FORCE_COLOR -u NO_COLOR pnpm vitest run apps/cli/tests/tui-interaction.spec.ts
```

结果：10/10 通过。

## 曾考虑的替代方案

**用真实模型轮次产生 `@` 的子会话。** 否决：它需要密钥，且会让名单变得不确定，快照因此失去意义。改由 fixture 在会话存储中创建一个活跃子会话，使 `subagents.listChildren` 经由生产环境所用的同一条路径返回它。

**桩化 subagent 名单。** 否决：一份伪造了自己声称要证明之状态的快照，比没有更糟。铺设真实的会话存储状态，能让断言指向接线本身，而非指向桩。

**用真实模型轮次或桩化 skill 目录来产生 `/` skill。** 出于同样原因否决：密钥会让测试非确定性，而桩化目录只能证明菜单渲染，无法证明 live skill 来源。skill fixture 注册了一个真实 runtime skill，并断言它可通过 `ctx.skills.list({ scope: agent })` 被看到。

**使用文件系统 skill 替代 runtime 注册。** 否决：这会把测试耦合到文件系统提供者的项目根发现与文件监听，引入非确定性与 I/O。runtime 注册具有作用域、同步、并随 fixture 一起拆除。

**在 `@` 用例中以 `/exit` 收尾。** 否决：该用例刻意在输入区留下 `@journey-child x`，因此 `/exit` 会被追加到该行而非作为命令执行。`cancel()` 发送 `ctrl+c`，在没有进行中的轮次时可干净退出。

**断言原始 PTY 字节而非渲染后的网格。** 否决：pi-tui 的差分渲染与同步输出使字节顺序成为实现细节，字节级断言会因读者根本看不见的重绘变化而失败。模拟器解释并剥除 ANSI，使快照钉住的是人所读到的内容。

**在按键之间使用挂钟休眠。** 作为 CI 抖动的常见来源而否决。为此新增了 `waitUntil(predicate)`，用于不便以文本表达的条件，例如模型选择面板已离开屏幕。

## 验收标准

- `/`、`/help`、`@`、`/` skill 来源、`@` 空列表、`/model` 的旅程快照存在且无密钥通过。
- 连续十次运行通过，无 flake。
- `pnpm run doc-sync`（28 道 gates）、`pnpm run typecheck`、`pnpm run hygiene` 保持通过。
- 基线 `pnpm vitest run packages/ui/tui packages/bundle/tui-app apps/cli/tests/tui-interaction.spec.ts` 提升到 359 passed / 16 files，且不破坏任何用例。
- 不修改 `packages/ui/tui/`。

## 后果

组装式终端交互覆盖现在与 harness 一起归属在 `apps/cli/tests/`。未来已发布的终端功能都在那里添加旅程快照，而不是留下诚实的缺口。这些 fixture 插件是在无密钥 CLI 测试中确定性上台子代理子会话与用户可调用 skill 的可复用模式。

## 风险

- 屏幕仿真器仍然是最小化的。如果 pi-tui 改变发出的序列，快照可能会漂移。风险可控，因为当前布局使用的序列是稳定的。
- `@` 用例依赖于子代理列表投影将带有 descriptor 的 live 子会话视为 running。如果该投影改变，fixture 必须同步更新，但快照本身会诚实地失败。
- `/` skill 用例依赖于 skill 注册表将全局 runtime 注册暴露给 agent 的作用域链。如果该可见性规则改变，fixture 必须同步更新，但快照本身会诚实地失败。

## 缺口

- 已关闭：`@` 空列表场景现在由不带子会话上台 patch 的专用快照覆盖。
- 已关闭：`/` skill 来源场景现在由带有真实 runtime skill 的专用快照覆盖。
- 已关闭：`/help` 拆解抖动并非 SIGPIPE，而是启动/退出竞态。插桩显示子进程以 code 13 退出，且 Node 打印 `Warning: Detected unsettled top-level await at apps/cli/src/bin.ts:33`。在聚合套件竞争下，harness 在 `profile-boot.ts` 仍在等待启动后 watcher 设置时发送 `/exit`，导致顶层 `await runProfile(...)` 在进程退出时仍未完成。harness 现在会在拆解写入前等待 PTY 空闲 `TEARDOWN_QUIET_MS`，并在子进程已退出时跳过写入，既给 CLI 完成启动的时间，也不掩盖真正的非零退出。已通过下方聚合命令验证。
  - `env -u FORCE_COLOR -u NO_COLOR pnpm vitest run packages/ui/tui packages/bundle/tui-app apps/cli/tests/tui-interaction.spec.ts`：**10/10 通过**。
