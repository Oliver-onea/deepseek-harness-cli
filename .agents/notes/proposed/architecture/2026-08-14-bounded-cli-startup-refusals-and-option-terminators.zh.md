# Agent Note：限制 CLI 启动拒绝并保留应用自有的选项终止符

Status: proposed

[English](2026-08-14-bounded-cli-startup-refusals-and-option-terminators.md) | 中文

## 问题

随产品发布的终端 profile 在确认持久化层能否读取 Session 之前就接受 `--resume <session>`。随后，屏幕会无限期等待 `agent/created`。缺失的 Session 或损坏的持久日志会阻止 agent 创建，因此这两个独立的生命周期缺口组合成一个静默进程：它不进入备用屏幕、不输出诊断，也永不退出。

由调用或部署配置造成的启动失败也会以普通 rejected `Error` 到达 CLI。Loader 和 boot 会增加 entry、stage 与 cause 上下文，所以 Node 会为非 TTY 终端、未知 profile 或缺失 overlay 路径等有意拒绝打印完整的未捕获堆栈。把所有失败都压平会隐藏内部崩溃，而匹配消息文本会让启动器耦合到插件措辞。

启动器只持有自己的 flag 前缀，并把剩余参数交给选中的应用。但是，Commander 会消费位于启动器边界的 `--`，所以应用会把后续 `--help` 视为自己的选项，而不是字面任务文本。出现在应用边界之后的终止符本来就会到达应用，导致相同语法因为边界建立位置不同而表现不同。

## 提案

`@deepseek-ai/dsh-app-boot/errors` 定义 `StartupRefusalError`，作为用户可修正启动失败的跨包标记。`classifyStartupFailure(error)` 会沿标准 `Error.cause` 链查找，因为 Loader 与 boot 包装器会增加上下文。`dsh` 进程边缘把标记消息严格打印为一行 stderr，并把退出状态设为 1。未标记值会保持原样重新抛出，保留其堆栈和 Node 的崩溃诊断。

已知的持久化与调用失败在持有相关知识的层使用该标记。Profile 查找标记未知 profile；patch 读取器标记不可读或无效的指定 overlay；TUI 标记其有意的 TTY 拒绝。启动器不检查消息字符串，也不会把任意插件异常分类为预期失败。

`tui-startup` 提供者注入 Session 持久化，并在发布恢复会话的启动值之前调用其非变更型 `inspect(SessionId)` 操作。因此，存在性、解压和持久格式验证都由持久化层持有。失败消息会指名请求的 id，包含持久化诊断，并提示用户检查 id 或日志，或省略 `--resume`。验证成功前，依赖的 agent 与屏幕行无法激活。

TUI 的第二层防护独立于恢复验证。它等待已配置 agent 的时间受正整数 `agentWaitTimeoutMs` 配置字段限制，默认 30 秒。超时会在进入备用屏幕之前抛出带类型的启动拒绝，并指名 Session 与设置。配置树释放仍会结束等待而不报告拒绝。意外的渲染器失败保留现有 logger 与 `ctx.appExit(1)` 路径。

选项终止采用单一解析器持有语义。启动器边界处的 `--` 会恢复为第一个内部参数；应用边界之后的 `--` 保留在原样后缀中。两种情况下都由选中应用的解析器消费终止符，并把后续形似 flag 的 token 当作位置文本。第一个无法识别的 token 仍建立应用边界，因此 `dsh --profile web -h` 继续选择 Web 帮助。

## 验证

包级测试覆盖服务发布前的持久化检查、缺失与不可读的恢复目标、有界 agent 等待、穿过包装 cause 的拒绝分类、未标记崩溃保留、循环 cause，以及选项终止符的两个位置。真实 Loader 组合与 PTY 测试覆盖重定向 stdin 和 stdout、在进入备用屏幕前处理缺失与损坏的恢复日志，以及严格的单行 stderr 行为。无密钥 snapshot 固定随产品发布的非 TTY 拒绝，构建后 CLI 套件固定未知 profile 与缺失 overlay 的报告，并通过 headless 应用把字面 `--help` 提交给 mock 模型。

## 考虑过的替代方案

**在启动提供者中检查 JSONL 路径来验证恢复。** 否决，因为文件布局与可读性属于已配置的持久化提供者；直接文件系统检查会跨越包边界，也无法覆盖替代持久化实现或持久数据解码。

**只增加恢复验证。** 否决，因为任何阻止 agent 创建的未来组合失败仍会保留 TUI 的无限等待。

**只增加 agent 超时。** 否决，因为它会延迟一个可直接解析的持久化错误，并以模糊的 agent 缺失拒绝取代精确的 Session 损坏或缺失诊断。

**使用固定的超时常量。** 否决，因为可接受的启动延迟因部署而异。默认值属于经过验证的插件配置，可以从 `cordis.yml` 修改。

**对每个启动拒绝只打印 `error.message`。** 否决，因为内部缺陷必须保留堆栈。带类型标记是抛出方作出的显式承诺：该失败属于预期拒绝。

**在启动器中匹配已知消息前缀。** 否决，因为插件措辞属于呈现，而不是稳定的分类机制；新插件也会迫使启动器修改。

**让启动器消费 `--`。** 否决，因为此时终止符没有保护任何应用参数。要求 `-- --` 会向用户暴露解析器分层，并让等价的应用参数后缀取决于启动器边界位置。

## 验收标准

- 缺失与损坏的恢复目标会以非零状态和针对 Session 的补救提示失败，且此前没有任何备用屏幕控制序列。
- 已配置但始终未出现的 agent 会在 `agentWaitTimeoutMs` 内失败；该字段经过验证并有文档说明。
- 预期的 TTY、profile 与 overlay 拒绝只产生一行 stderr，不含堆栈、内部路径或 Node 横幅。
- 未标记的内部启动错误会保持原样重新抛出，并保留堆栈。
- 应用边界前后的 `--` 都到达应用解析器，同时 `dsh --profile web -h` 仍显示 Web 帮助。
- `dsh --profile headless -- --help` 会提交字面 `--help` 任务。

## 风险

合法 agent 创建时间超过默认值的部署可能收到拒绝；经过验证的配置字段让该选择保持显式。恢复 Session 时，持久化检查会增加一次启动读取，因此持久化实现应在已有缓存的位置复用其检查结果。错误地标记内部异常的插件可能压掉堆栈，所以该标记仅限直接可由用户修正的情况，分类测试也通过对象身份保留未标记值。

本提案扩展[终端前门决策](../../implemented/feature/2026-08-13-terminal-front-door-returns.md)与[应用自有命令行决策](../../implemented/architecture/2026-08-06-app-owned-command-line.md)；两者仍对其更广泛的界面保持权威。本提案应用现有的[明确失败终端释放](../../implemented/bug-fix/2026-07-31-fail-loud-releases-the-terminal.md)与[原因链诊断](../../implemented/bug-fix/2026-07-20-error-cause-chain-diagnostics.md)机制，但不取代它们。没有活动笔记被归档或删除。
