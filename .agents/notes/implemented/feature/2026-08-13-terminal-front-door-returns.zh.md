# Agent Note：终端前门回归，成为 dsh 的默认界面

Status: implemented

[English](2026-08-13-terminal-front-door-returns.md) | 中文

## 问题

仓库名为 `deepseek-harness-cli`，但 `dsh` 却没有交互式命令行。[显式配置入口决策](../../archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.md)移除了隐式终端应用，随后[整包移除决策](../simplification/2026-08-04-remove-tui-package.md)删掉了 `@deepseek-ai/dsh-tui` 本身，只留下 Web 作为唯一交互界面、一次性 headless 应用作为唯一命令行。裸 `dsh` 是一个用法错误。

那次移除自己写明了回归条件：具体的产品需求、具名入口模式而非隐式裸默认、明确的包边界、具体的交互提供者，以及该前端的组装式生命周期验收。产品需求现在就是仓库自身的定位 —— CLI 产品需要交互式终端，而不只是任务进、文本出。

## 决策

DeepSeek Harness 重新提供终端前门，形式是**两个各司其职的包**，且在调用未指定 profile 时由 `dsh` 启动。

[`@deepseek-ai/dsh-tui`](../../../../packages/ui/tui/README.md) 是可复用的 Cordis 插件：它渲染一个活跃 agent 并接管终端输入，仅此而已。它是新建 `ui/` 组的唯一成员；该组的存在是为了不让终端界面被归入 `client/`／`host/` 这些浏览器一半。[`@deepseek-ai/dsh-tui-app`](../../../../packages/bundle/tui-app/README.md) 是随产品发布的组合：覆盖在 `dsh-base` 之上的 patch 层，加上解析会话、路由与可选首个任务的命令行提供者。

采用组合而非启动器默认值：`PROFILE_TEMPLATES` 新增 `tui` 条目（`dsh-base` + `dsh-tui-app`），`apps/cli` 把缺失的 `--profile` 视作 `tui`。`dsh`、`dsh "run the tests"` 与 `dsh --resume <session>` 都会到达终端应用自己的标志；未指定 profile 的 `dsh -h` 仍打印启动器帮助，因为此时还没有应用可以接手 `-h`。

agent 平面保持在 `dsh-base` 放置的位置。这个界面是单会话的，并在进程级组合一个 agent，因此 bundle 不挂载 preset 名册 —— 与 `dsh-web-app` 相反，后者禁用那些行并让每个会话各自挂载 preset。

### 前门拥有什么，不拥有什么

它拥有呈现与终端输入。对话记录由**追加来源的会话日志**折叠而成，而非模型可见表面，因此恢复的会话保留读者看过的每条消息，被压缩的区间也仍可读地留在其标记之后。工具卡片由每个工具自己的 `presentCall`/`presentResult` 绘制，因此工具改变它在终端中的呈现靠改自己的 presenter。

它还拥有三项 agent 作用域状态，原因都是：在单会话组合中没有别的行能承担。它们是 `userQuestions` 提供者、仅作用于自身 agent 的 `approval/request` 应答器（其他 agent 的提问交由调用链其余部分处理），以及填充 persona 的 `{{provider}}`/`{{model}}` 变量并路由每次请求的模型选择引用。`agent-loop` 不为已配置的 agent 安装该引用 —— 由入口点安装，正如 `dsh-headless` 与 Web 宿主一直所做的那样。

它要求 stdin 与 stdout 都是 TTY，否则在挂载时抛出带类型的启动拒绝，而不发生退化。启动提供者会先通过 Session 持久化检查请求恢复的会话，再发布自身服务；渲染器等待指定 agent 的时间只持续到经过验证的 `agentWaitTimeoutMs`。两项检查都在进入备用屏幕前完成，因此缺失或不可读的会话以及损坏的 agent 组合都会报告到普通终端。

### 终端所有权

`displayText()` 在任何字符串到达 pi-tui 或窗格标题之前先做规范化：折叠回车、展开制表符，并把其他所有 C0、DEL 与 C1 控制字符变成可见的 `\xNN` 转义。转义而非剥离，能让文本对自己曾包含什么保持诚实，也正是它阻止了不受信任的工具输出或模型文本重绘屏幕、设置窗格标题。只有本包与 pi-tui 会产生 ANSI 序列。

调色板是标准 16 色 ANSI 前景色与 SGR 属性，正文与背景保持终端默认值，因此宿主终端会为浅色与深色主题重映射界面，而无需 TUI 专属的主题设置。

### 渲染依赖

`@earendil-works/pi-tui` 提供差分渲染器、备用屏幕视口、带自动补全与粘贴处理的编辑器、Markdown 渲染器以及按键解析。它与已被依赖的 `@earendil-works/pi-ai` 同源，采用 MIT 许可。自行实现全屏渲染器会带来产品级规模的自有代码与测试，而这正是[优先使用依赖而非手写的策略](../process/2026-07-26-dependencies-over-hand-rolling.md)所要避免的。与被删包所携带的产物不同，这个版本不需要打补丁。

## 验证

包级测试对折叠逻辑、卡片渲染器、底栏、提问面板、审批应答器与插件保持每文件 100% 覆盖率，并以替换的 `Terminal` 与真实 `SessionStore` 驱动真实插件体，使 append 像生产环境一样发布 `session/event`。

PTY 覆盖获得许可，因为被测对象就是终端接管本身，而管道无法证明它（[将 PTY 保留给此情形的测试策略](../../archived/simplification/2026-07-20-retire-readline-front-door.md)）：`packages/ui/tui/tests/pty-boot.spec.ts` 通过 `dsh` 启动器针对无密钥 mock 模型启动随产品发布的 `tui` profile，提交提示，等待答案出现在屏幕上，并以 `/exit` 退出、退出码为 0。同一个真实组合还证明，stdin 或 stdout 被重定向时只会收到一行拒绝，并且缺失或损坏的恢复日志会在进入备用屏幕前失败。

## 考虑过的替代方案

**从历史中恢复被删的包。** 既不可能也不可取：删除发生在可用历史之前，而且移除笔记明确指出未来的终端前端应当从它真实的宿主与交互需求出发，而不是继承一份实现。

**让 `dsh` 保持为用法错误，另加 `tui` 子命令。** 否决：本仓库的产品就是命令行；一个拒绝运行的裸 `dsh`，比它所发布的唯一交互界面更糟糕的默认值。

**把屏幕放进 bundle。** 否决：patch 层与渲染器的变更理由不同，而可复用的前门正是让部署方能在自己的 agent 平面之上组合终端的原因。

**从模型可见表面渲染对话记录。** 否决：压缩会在那里替换区间，读者会眼看着自己的对话消失。

## 影响

无参数的 `dsh` 打开终端对话，`dsh "<task>"` 以该任务开始一次对话。Web 仍是随产品发布的浏览器界面，headless 仍是一次性自动化入口；两者都没有变化。

组合 `dsh-tui` 的部署必须提供 TTY 与 `ctx.appExit`，并且必须指名一个由自身组合创建的 agent 的会话 id；当启动延迟不同于默认的 30 秒时，还可以设置 `agentWaitTimeoutMs`。没有 `ctx.commands` 的组合仍可工作 —— 编辑器把每一行都送给模型，`/exit` 不可用，`ctrl+c` 成为退出方式。

终端模型选择器现在有了写入位置：模型选择引用已由该前门安装并拥有，只是还没有命令暴露它。
