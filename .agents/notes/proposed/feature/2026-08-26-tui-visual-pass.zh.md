---
title: 終端介面視覺豐富度提升
status: proposed
author: agent
created: 2026-08-26
---

# 終端介面視覺豐富度提升

[English](2026-08-26-tui-visual-pass.md) | 中文

本文檔基於對其他終端代理（`claude`、`kimi`、`qwen`）的調查，提出了對終端 UI (TUI) 視覺改進的建議與記錄。

## 動機
與同類產品相比，原有的終端介面感覺較為粗糙，且缺乏對各類 Markdown 及結構元素的獨特著色。初始調色盤將多個語義角色重載為少數幾種色相，並完全省略了背景色。

## 調色盤調查結果

| Product | Distinct Foregrounds | Distinct Backgrounds | Attributes Used | Notes |
|---------|---------------------|----------------------|-----------------|-------|
| **claude** | 5 (truecolor) | 1 (truecolor) | bold, dim | 標題部分大量使用獨特的背景色。 |
| **kimi** | 5 (truecolor) | 0 | bold | 乾淨的佈局，有顏色的檔案路徑和指令。 |
| **qwen** | 4 (truecolor) | 1 (truecolor) | bold | 提示列文字後方使用獨特背景色。 |
| **codex** | 0 (no truecolor) | 0 | bold, dim | 極簡樣式。 |
| **agy** | 0 (no truecolor) | 0 | none | 極簡樣式。 |
| **opencode**| 0 (no truecolor) | 0 | none | 極簡樣式。 |
| **dsh** (old) | 6 (truecolor) | 0 | bold, dim, reverse | 多個角色使用重複的色相。 |

### Gap List
1. **背景色**：`claude` 和 `qwen` 都為結構區域使用了背景色。我們完全沒有使用。
2. **重複的配色對**：我們為 `tool`/`accent`、`success`/`added` 和 `error`/`removed` 重載了相同的顏色。
3. **Markdown 元素**：標題、連結和引用缺乏獨特的視覺處理。
4. **程式碼語法高亮**：參考產品對語法 token 進行高亮；我們為所有程式碼使用單一扁平顏色。

## 考慮過的替代方案
1. **加入重量級語法高亮套件**：如果會增加過多的構建體積與啟動時間，則不予考慮。只有在 vendored `pi-tui` 原生支援時，我們才會使用基於 token 的樣式。
2. **完全複製其他產品的調色盤**：不予考慮，因為我們希望在達到豐富度平權的同時，保持自己的品牌識別。
