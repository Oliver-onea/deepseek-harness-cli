# Agent Note: 終端介面視覺豐富度提升

Status: proposed

[English](2026-08-26-tui-visual-pass.md) | 中文

## Problem
與同類產品相比，原有的終端介面感覺較為粗糙，且缺乏對各類 Markdown 及結構元素的獨特著色。初始調色盤將多個語義角色重載為少數幾種色相，並完全省略了背景色。

## Proposal
基於對其他終端代理（`claude`、`kimi`、`qwen`）的調查，我們建議對終端 UI 進行以下視覺改進：
1. **分離重複的配色**：將獨特色相從 6 種增加到 11 種。加入紫紅色 (`0xd9, 0x46, 0xef`) 作為 `tool` 顏色，以與 `accent` 藍色區分。由於 diff 顏色在語義上等同於 `success` 和 `error`，因此刪除了 `added` 和 `removed` 角色，並分別以 `success` 和 `error` 取代。
2. **語法高亮**：使用 `pi-tui` 的 `MarkdownTheme` 支援，加入輕量級基於正則表達式的 `highlightCode` 函式，支援 TS/JS、JSON、shell、markdown 和 diff，不需依賴重量級套件。
3. **Markdown 元素**：`heading`、`quote`、`link`、`italic` 和 `strikethrough` 獲得獨立顏色與樣式 (SGR)。
4. **Diff 背景染色**：不予採用。調查確認參考產品並未使用背景染色處理 diff 變更行。
5. **圓角設計**：將 `tool-card.ts` 中的方形折角 `└` 改為 `╰`。

## Acceptance criteria
- `packages/ui/tui` 中的所有測試通過。
- 新角色已定義並在 16 色、256 色和 truecolor 深度的終端中擁有獨立樣式。
- 輕量級的正則表達式語法高亮可以運作，且不會引入過大的依賴。

## Risks
基於正則表達式的高亮可能會在複雜的極端情況下出錯，但它提供了「足夠好」的近似效果，並大幅提升了 UI 的感知豐富度。

## Alternatives considered
無。
