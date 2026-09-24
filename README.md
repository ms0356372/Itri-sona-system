# 超音波健檢報到暨診間管理系統

同一套 **React + TypeScript + Vite PWA** 支援 Windows 健檢報到站、Android 超音波控制台與多台 Android 診間。第一階段以 Supabase 保存當次排程與正式狀態，以每台平板的 IndexedDB 保存歷年結果；不依賴院方 EXE。

## 已完成的第一階段骨架

- 觸控優先工作站介面、PWA manifest 與離線應用殼。
- 報到站名單 Excel 欄名正規化、驗證、比對與預覽；工號一律用字串並保留前導零。
- PostgreSQL 交易式 A–G 報到流水號、冪等報到與完成、狀態轉換 RPC。
- Supabase Auth、場次成員角色、RLS、Realtime publication。
- 今日雲端排程以場次 UUID、participant UUID 與工號識別，不保存身分證。
- Dexie 本機歷年資料及未完成檢查草稿；結果不會上傳 Supabase。
- 可設定的超音波項目、診間統計、設備清除回報與 Phase 2 Bridge 介面。

> 首頁在未設定 Supabase 時提供「設定模式」與虛構介面資料，方便確認安裝；正式資料讀寫一定需要已登入的工作人員。第一階段不再依工作站或診間細分資料庫權限。

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
2. Repository 已連接 Supabase GitHub Integration 時，設定 Production branch 為 `main`、Working directory 為 `.`，並開啟 **Deploy to production**。合併含有 `supabase/migrations/202609230001_initial.sql` 的 PR 後，由 Integration 套用尚未執行的 migration，不需要在 Windows 安裝 CLI。
3. 在 Authentication 建立工作人員帳號，並關閉不符合院方帳號管理政策的公開註冊方式。第一階段以「已成功登入」作為工作人員授權邊界；所有工作人員可操作主要流程，不做工作站角色分級。
4. 複製 `.env.example` 為 `.env.local`，填入 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`。不要使用 service role。

Migration 會建立資料表、交易式 RPC、RLS、明確 GRANT 與 Realtime publication。`anon` 沒有資料表權限，且所有今日排程查詢都只允許 `authenticated`；瀏覽器端仍只能使用 Publishable/anon key，由登入 JWT 配合 RLS 放行。`participants` 不含身分證欄位，完整公司大名單只存在報到站的 IndexedDB。

### 第一次資料庫部署檢查

合併到 `main` 後，在 Supabase Dashboard 的 GitHub Integration deployment/logs 確認 migration 成功，再到 **Database → Migrations** 確認 `202609230001_initial`，並到 **Table Editor → public** 確認資料表。不要在 SQL Editor 重貼 migration；否則 Integration 不會擁有一致的 migration history，且可能嘗試重建已存在物件。

若合併後仍顯示 **Last migration: No migrations**，依序檢查 GitHub Integration：

1. 連接的 repository 必須是 `ms0356372/Itri-sona-system`，且 Supabase GitHub App 對該 repository 仍有存取權。
2. Production branch 必須是 `main`、Working directory 必須是 `.`、**Deploy to production** 必須開啟；migration 的相對路徑應為 `supabase/migrations/202609230001_initial.sql`。
3. 查看該次 production deployment log。若沒有 deployment，重新儲存 Integration 設定後，對 `main` 產生一個包含 migration 變更的新 merge/push 事件；若有 deployment 但失敗，先依 log 修正 SQL，不要建立空白或重複 migration。
4. 若 Dashboard 顯示 GitHub 授權或 repository 權限錯誤，從 Integration 重新授權 Supabase GitHub App，並只授予必要 repository；不需、也不可把 database password、personal access token、service-role key 或 secret key提交到 GitHub。

資料庫 RPC 負責狀態轉換，前端不計算最大報到號。`participants(session_id, employee_no)` 與報到編號均有唯一約束；完成 RPC 在資料列鎖內冪等處理。

### 移除既有 `participants.national_id`

`202609240001_remove_participant_national_id.sql` 是已部署初始 schema 的增量 migration；初始 migration 不會被回寫。它只移除舊欄位與其索引，不會停用或放寬 RLS，也不會修改報到流水號、場次 UUID、participant UUID 或狀態 RPC。

正式環境套用前，請由資料庫管理者在 Supabase SQL Editor 先執行唯讀盤點：

```sql
select count(*) as participant_count,
       count(*) filter (
         where national_id is not null and length(trim(national_id)) > 0
       ) as populated_national_id_count
from public.participants;

select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_definition ilike '%national_id%';
```

若 `populated_national_id_count` 大於 0，migration 會故意中止，不會把資料改成假值、空字串、`note`、JSON 或其他雲端欄位。請先依院方核准程序確認刪除影響，並在允許的離線位置完成必要的留存；確認可以永久移除後，由資料庫 owner 明確設定一次性核准旗標：

```sql
alter database postgres
  set app.confirm_participant_national_id_removal = 'confirmed';
```

重新連線並套用 migration，確認 `public.participants` 已不存在 `national_id` 後，立即移除旗標：

```sql
alter database postgres
  reset app.confirm_participant_national_id_removal;
```

驗證 schema、RLS 與 RPC：

```sql
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'participants';

select relrowsecurity
from pg_class
where oid = 'public.participants'::regclass;

select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('check_in_participant', 'set_waiting_status');
```

預期欄位清單中沒有 `national_id`、`relrowsecurity` 仍為 `true`，且兩個報到 RPC 仍存在。若正式環境沒有既有身分證資料，migration 可直接安全套用，不需設定核准旗標。

## Excel

廠商大名單至少包含工號、姓名、身分證、性別、`活動項目(原始)` 與`項目`；它只保存在報到站 IndexedDB，供當日比對與完整 Excel 匯出使用。每日排程至少包含工號、姓名、排程日期、排程時段與活動項目，不需要也不應包含身分證。Excel 若把 `00125` 儲存為數值 `125`，檔案本身已失去前導零，系統無法推測；來源欄必須設定成文字。

歷年資料匯入支援手動對應當時工號、姓名、年份、日期、種類與結果；不匯入或保存身分證，去重指紋也不含身分證且不會修改結果原文。資料僅在匯入的瀏覽器 profile / IndexedDB 中；既有診間 IndexedDB 升級時會移除舊版歷年紀錄中的身分證欄位。虛構資料：`npm run fixtures`（或直接執行 `node scripts/generate-fixtures.mjs`）。

## 正式部署與 GitHub

1. CI 會在 push/PR 由 npm registry 解析真實 lockfile，再以 `npm ci` 執行 typecheck、lint、test、build；產生的 lockfile 會保存為 Actions artifact 供審查。待從 CI artifact 取回並提交 `package-lock.json` 後，應重新啟用 setup-node `cache: npm`，並移除 lockfile bootstrap 步驟。
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

- 不提交正式個資、Excel 或 `.env`；身分證只保存在報到站本機 IndexedDB 與使用者主動匯出的完整 Excel，不寫入 Supabase、`note`、JSON、其他文字欄位、console 或 error log。
- RLS 是資料邊界，按鈕隱藏不是授權。只有 Supabase Auth 已登入的受管理工作人員可讀寫作業資料；應停用不需要的公開註冊並落實帳號停權流程。
- 歷年醫療內容不經雲端同步；裝置需螢幕鎖、磁碟加密、遠端管理及人員交接程序。
- 正式上線前必須完成院方威脅模型、DPIA/法遵、備份與復原演練、稽核及 Supabase 專案安全設定審查。

## 第二階段邊界

`src/features/bridge/` 只定義可呼叫相同 check-in service 的事件介面。第一階段沒有 EXE 監控、UI Automation、log/database reader 或 scanner bridge；未來確認院方系統能力後才實作。

## GitHub Pages 正式發布

正式網址為 <https://ms0356372.github.io/Itri-sona-system/>。Vite、PWA manifest、Service Worker navigation fallback 與圖示都使用 `/Itri-sona-system/` 子路徑；請勿把 Pages 網址改成 Repository 根網域。

### 第一次啟用

1. 在 GitHub Repository 開啟 **Settings → Pages**。
2. 在 **Build and deployment → Source** 選擇 **GitHub Actions**，不要選擇從 branch 直接發布。
3. 開啟 **Settings → Secrets and variables → Actions → Variables**，建立：
   - `VITE_SUPABASE_URL`：Supabase Project URL。
   - `VITE_SUPABASE_PUBLISHABLE_KEY`：Supabase Publishable Key（舊專案可能顯示 anon key）。
4. 不要建立、上傳或在前端使用 Supabase Secret Key / Service Role Key。`VITE_` 變數會被編譯進公開的瀏覽器 bundle，只能放可公開的 URL 與 Publishable Key；實際資料權限必須由 Supabase Auth 與 RLS 控制。
5. 在 Supabase Authentication 的 URL Configuration 將正式 Site URL 設為上述 Pages 網址，並視登入流程加入相同網址作為允許的 Redirect URL。
6. 合併或推送到 `main` 後，`Deploy GitHub Pages` workflow 會先執行 typecheck、lint、test、build，全部成功才上傳 `dist` 並部署。也可在 Actions 頁面用 `workflow_dispatch` 手動重新發布。

若 Actions 顯示 environment protection 等待核准，請在 **Settings → Environments → github-pages** 調整部署規則。發布完成後請用無痕視窗檢查首頁、`manifest.webmanifest`、Service Worker、`icon.svg`，並在 Android Chrome 重新安裝或更新 PWA。Supabase variables 修改後必須重新執行部署，因為 Vite 會在 build 階段寫入公開前端 bundle。
