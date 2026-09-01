# SHOPLINE 自動化週報（Google Apps Script）

`shopline-weekly-report.js` — 讀取試算表裡的「官網訂單」工作表，產出每週的銷售週報。

## 資料流

```
SHOPLINE 後台
  └─(shopline-order-import skill，每日)→ Google Sheet「官網訂單」(A~CQ 95 欄)
        └─(本腳本，每週一 09:00)→「SHOPLINE週報」＋「SHOPLINE週報歷史」
```

腳本本身不碰 SHOPLINE API，只在試算表內運算，因此不需要任何 API 金鑰。

## 產出內容

**「SHOPLINE週報」**（每次執行整份重建）

| 區塊 | 內容 |
|------|------|
| 1. 整體 KPI | 營收、訂單數、客單價、商品件數、每單件數、下單顧客數；各自附「上週 / 週對週 / 去年同期 / 年對年」 |
| 2. 商品銷售排行 | 依銷售額 Top 15，含件數、銷售額、佔比、上週件數與件數增減 |
| 3. 訂單來源分析 | 依訂單來源（前台購物網站 / 一頁式購物 / 其他）分訂單數、營收、佔比、WoW |
| 4. UTM 來源 / 媒介 | Top 10 組合的訂單數、營收、佔比、WoW |
| 5. UTM 活動 | Top 10 活動名稱的訂單數、營收、佔比、WoW |

**「SHOPLINE週報歷史」** — 每週一列（週別、起訖、營收、訂單數、客單價、件數、顧客數、WoW、YoY），同一週重跑會覆蓋該列，可直接餵給儀表板拉趨勢。

## 統計規則

- **週定義**：週一 ~ 週日。`generateWeeklyReport()` 一律算「上一個完整週」。
- **去年同期**：往前 364 天（52 週），保持星期對齊，而非同一日曆日期。
- **營收去重**：一筆多商品訂單在「官網訂單」會拆成多行，且訂單合計（G 欄）只填在第一行。腳本先把資料列還原成訂單物件，每筆訂單只取一次合計；若該筆訂單完全沒有合計值，才退回用商品合計加總。
- **取消訂單**：訂單狀態含「取消」或 `cancel` 者整筆排除（可在 `CONFIG.EXCLUDED_STATUS_KEYWORDS` 調整）。
- **欄位定位**：先比對標題列名稱，找不到才退回 `shopline-order-import` 的固定欄序（訂單合計 G、訂單來源 S、訂單日期 U、SKU BW、數量 CE…），所以中間插欄不會壞掉。
- **日期解析**：同時吃 Date 物件、`YYYY-MM-DD`、`YYYY/M/D`。

## 設定

`CONFIG` 區塊：

| 欄位 | 預設 | 說明 |
|------|------|------|
| `SPREADSHEET_ID` | `14C5m2F05...` | 目標試算表 |
| `SOURCE_SHEET_NAME` | `官網訂單` | 來源工作表 |
| `REPORT_SHEET_NAME` | `SHOPLINE週報` | 週報工作表（不存在會自動建立） |
| `HISTORY_SHEET_NAME` | `SHOPLINE週報歷史` | 歷史彙總工作表 |
| `TOP_N_PRODUCTS` / `TOP_N_UTM` | 15 / 10 | 排行長度 |
| `TRIGGER_WEEKDAY_HOUR` | 9 | 每週一觸發時間 |

## 函式

| 函式 | 用途 |
|------|------|
| `generateWeeklyReport()` | 產生上一個完整週的週報（排程進入點） |
| `generateWeeklyReportForDate('2026/08/24')` | 產生指定日期所屬那一週的週報（補跑用） |
| `installWeeklyTrigger()` | 安裝每週一 09:00 觸發器（會先清掉舊的） |
| `removeWeeklyTriggers()` | 移除本腳本的週報觸發器 |
| `onOpen()` | 繫結試算表時掛上「SHOPLINE 週報」自訂選單 |

## 部署

1. 開啟目標試算表 → 擴充功能 → Apps Script。
2. 把 `shopline-weekly-report.js` 全文貼進編輯器（或依 `gas-inject-and-run` skill 用 base64 分塊注入），儲存。
3. 手動執行一次 `generateWeeklyReport`，完成 OAuth 授權（需要試算表讀寫與觸發器權限）。
4. 執行 `installWeeklyTrigger` 掛上每週一自動排程。
5. 重新整理試算表，之後可從「SHOPLINE 週報」選單手動補跑任一週。

> 本檔為配合 `gas-inject-and-run` 的注入限制，全檔使用 ES5 語法且不含反引號（`` ` ``），修改時請維持這個限制。
