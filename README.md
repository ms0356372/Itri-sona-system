# 超音波健檢報到暨診間管理系統

同一套 **React + TypeScript + Vite PWA** 支援 Windows 健檢報到站、Android 超音波控制台與多台 Android 診間。第一階段以 Supabase 保存當次排程與正式狀態，以每台平板的 IndexedDB 保存歷年結果；不依賴院方 EXE。

## 已完成的第一階段骨架

- 觸控優先工作站介面、PWA manifest 與離線應用殼。
- 今日 Excel 欄名正規化、驗證、預覽；工號一律用字串，身分證大寫。
- PostgreSQL 交易式 A–G 報到流水號、冪等報到與完成、狀態轉換 RPC。
- Supabase Auth、場次成員角色、RLS、Realtime publication。
- 診間三路查詢所共用的身分比對規則、工號異動／衝突警告。
- Dexie 本機歷年資料及未完成檢查草稿；結果不會上傳 Supabase。
- 可設定的超音波項目、診間統計、設備清除回報與 Phase 2 Bridge 介面。

> 首頁在未設定 Supabase 時提供「設定模式」與虛構介面資料，方便確認安裝；正式資料讀寫一定需要已登入且被加入場次的使用者。

## Windows 開發

需求：Node.js 22、Git，以及 Supabase CLI（如要套用本機 migration）。

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev -- --host
```

瀏覽終端顯示的網址。型別、品質與建置檢查：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

## 建立 Supabase

1. 在 Supabase Dashboard 建立專案，保留 Project URL 與 **Publishable/anon key**；絕不可將 service-role/secret key放進前端或 Git。
2. 用 CLI 登入及連結專案：`supabase login`、`supabase link --project-ref <ref>`。
3. 套用資料表、函式、RLS 與 Realtime：`supabase db push`。Migration 位於 `supabase/migrations/`。
4. 在 Authentication 建立管理者帳號。先由受信任的 SQL/Admin 程序建立場次與 `session_memberships`；每個帳號只可存取被加入的場次。
5. 複製 `.env.example` 為 `.env.local`，填入 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`。不要使用 service role。
6. 診間設備使用個別 Auth 帳號或受管理裝置帳號，在 membership 指定 `clinic` 與 `room_id`；控制台使用 `console`，報到站使用 `registration`。

資料庫 RPC 負責狀態轉換，前端不計算最大報到號。`participants(session_id, employee_no)` 與報到編號均有唯一約束；完成 RPC 在資料列鎖內冪等處理。

## Excel

今日排程必要欄：`序號`、`人員工號/工號`、`人員姓名/姓名`、`性別`、`排程時段`、`項目`、`身分證/身份證/ID`。Excel 若把 `00125` 儲存為數值 `125`，檔案本身已失去前導零，系統無法推測；來源欄必須設定成文字。

歷年資料匯入支援手動對應身分證、當時工號、姓名、年份、日期、種類、結果；去重指紋不會修改結果原文。資料僅在匯入的瀏覽器 profile / IndexedDB 中。虛構資料：`npm run fixtures`（或直接執行 `node scripts/generate-fixtures.mjs`）。

## 正式部署與 GitHub

1. CI 會在 push/PR 執行 typecheck、lint、test、build。
2. 在 Vercel、Netlify、Cloudflare Pages 或 GitHub Pages 建立 Vite site：build command `npm ci && npm run build`，輸出 `dist`。
3. 在部署平台設定兩個 `VITE_` 環境變數，並設定所有 SPA 路徑 fallback 到 `index.html`。
4. 必須使用 HTTPS；確認 Supabase Auth Site URL / redirect URL 是正式網域。
5. 若部署到 GitHub Pages 子路徑，需同步設定 Vite `base`、PWA `start_url` 及 Pages fallback；自訂網域根路徑較簡單。

## Android 平板與多診間

1. 用 Chrome 開啟 HTTPS 正式網址，登入被授權的設備帳號。
2. 選單選「安裝應用程式」或「加到主畫面」，允許站點儲存空間；不要使用無痕模式。
3. 每台平板建立不同設備 ID/診間，加入同一 `health_session`。控制台訂閱該場次 Realtime；各診間仍各自匯入本機歷史資料。
4. 正式開始前，用兩台設備測試報到、叫號、開始、完成及斷線提示。裝置時間應自動校時，資料庫存 UTC，畫面以 `Asia/Taipei` 顯示。
5. PWA shell 可離線開啟，但正式完成必須等 Supabase 成功回覆；離線時維持「檢查中／待同步」，不可宣告完成。

## 結束場次與資料生命週期

管理者先查看總人數、報到、完成、未完成、各診間件數，再發出清除要求。每台在線診間清空自己的 history/draft IndexedDB 後回報；離線或未回報設備會保留 pending，雲端流程不會假裝其已清除。請逐台確認後才能關閉場次。

`DELETE` 只清除此應用的線上作業資料與在線瀏覽器資料，**不代表 Supabase 備份、WAL、瀏覽器備份或實體媒體立刻且不可復原**。保留期限、備份刪除及裝置退役須依院方與 Supabase 方案另訂政策。本系統不會刪除院方原正式健檢系統。

## 安全注意事項

- 不提交正式個資、Excel 或 `.env`；畫面預設遮罩身分證，不寫入 console/error log。
- RLS 是資料邊界，按鈕隱藏不是授權。管理員才能管理項目、場次與異常修正。
- 歷年醫療內容不經雲端同步；裝置需螢幕鎖、磁碟加密、遠端管理及人員交接程序。
- 正式上線前必須完成院方威脅模型、DPIA/法遵、備份與復原演練、稽核及 Supabase 專案安全設定審查。

## 第二階段邊界

`src/features/bridge/` 只定義可呼叫相同 check-in service 的事件介面。第一階段沒有 EXE 監控、UI Automation、log/database reader 或 scanner bridge；未來確認院方系統能力後才實作。
