# Agent Note：TUI `colorDepth: none` 锁定无色档位

Status: proposed

[English](2026-09-02-tui-color-depth-none-colorless.md) | 中文

## 问题

TUI 配置表声明 `colorDepth: truecolor | 256 | 16 | none`，其中 `none` 锁定降级阶梯（truecolor → 256 → 16 → 无色）的无色档位。`resolveColorDepth` 已经遵循该约定：对 `none` 与 `color: false` 都返回 `undefined`。但构建调色板的唯一调用点用 `depth ?? '16'` 把这个 `undefined` 又折回成一个深度，并原样传入 `color` 标志，于是 `colorDepth: none` 配 `color: true` 时构建的是 16 色档位，冷启动时发出 616 条 SGR 序列——与 `colorDepth: 16` 无法区分，与文档中的无色档位恰恰相反。

对构建后的 CLI 做 PTY 探针证实了这一点：用 `--patch` 把 `colorDepth` 设为 `none` 发出 616 条 SGR 序列，与 `colorDepth: 16` 完全相同，而 `--no-color` 只发出 52 条（pi-tui 自身的编辑器重置与反显选区，本包不控制）。README 是对的；代码不是。

## 方案

把调色板的组装上提为 `createTerminalPalette(color, colorDepth, env)`——把配置的深度与实时终端环境变成渲染器所用调色板的唯一之处。它通过 `resolveColorDepth` 解析深度，再以 `depth !== undefined` 作为是否发 SGR 的标志、`depth ?? '16'` 作为档位来构建调色板，于是 `undefined` 深度——`none` 或 `color: false`——产出无色（恒等）调色板，而不是落到 16 色。`createPalette` 保持其约定：直接调用方省略深度时仍得到 16 色档位，因为默认参数是 `'16'`，而非 `undefined`。

修复后，同一 PTY 探针在 `colorDepth: none` 下发出 52 条 SGR 序列，与 `--no-color` 一致，只剩 pi-tui 自身的序列。一条回归测试断言 `createTerminalPalette(true, 'none', env)` 是无色的。

## 考虑过的替代方案

### 为什么不直接改 `createPalette` 让 `undefined` 深度为无色？

`createPalette` 的默认参数是 `'16'`，而 JavaScript 在实参为 `undefined` 时就会应用默认值，所以 `createPalette(true, undefined)` 仍会拿到 `'16'` 并返回 16 色档位。要把显式 `undefined` 与省略参数区分开，就得去掉默认值并强迫每个直接调用方（`createPalette(false)`、`createPalette(true)` 以及启动选择器）都传显式深度——这会在测试套件间造成大量改动却毫无收益，还会破坏“直接调用方即得调色板”这一文档化的便利。

### 为什么不只在调用点修复、而不新增函数？

单行的调用点修复（`createPalette(depth !== undefined, depth ?? '16')`）是对的，但要在不启动整个 CLI 进 PTY 的情况下测试它，因为该组装内联在 `start()` 里。抽出 `createTerminalPalette` 给回归测试一个纯函数接缝，并命名渲染器实际执行的操作：由终端配置与环境构建调色板。

## 风险

`colorDepth: none` 现在不再从本包发出 SGR，于是 `/model` 选择器的光标行——它用 `palette.selected`——在 `none` 下不再靠反显区分，与 `--no-color` 下一致。这与读者所要求的无色轴相符，且与 `color: false` 现有的、被测试覆盖的行为一致；无色调色板是否应保留反显选区是另一个设计问题，本文不处理。

## 验收标准

- `createTerminalPalette(true, 'none', env)` 返回无色调色板：每个样式都是恒等的，`error`、`accent`、`selected` 都不发 SGR。
- `colorDepth: 16 | 256 | truecolor` 配 `color: true` 仍绘制对应档位；`color: false` 仍无论锁定何深度都强制无色调色板。
- 在 `colorDepth: none` 下 PTY 启动时，本包调色板不发 SGR，与 `--no-color` 的计数一致。
