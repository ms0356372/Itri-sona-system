# 超音波健檢報到暨診間管理系統

同一套 **React + TypeScript + Vite PWA** 支援 Windows 健檢報到站、Android 超音波控制台與多台 Android 診間。第一階段以 Supabase 保存當次排程與正式狀態，以每台平板的 IndexedDB 保存歷年結果；不依賴院方 EXE。

## 已完成的第一階段骨架

- 觸控優先工作站介面、PWA manifest 與離線應用殼。
- 報到站名單 Excel 欄名正規化、驗證、比對與預覽；工號一律用字串並保留前導零。
- PostgreSQL 交易式 A–G 報到流水號、冪等報到與完成、狀態轉換 RPC。
- Supabase Auth、三個獨立工作頁面權限、RLS、Realtime publication。
- 今日雲端排程以場次 UUID、participant UUID 與工號識別，不保存身分證。
- Dexie 本機歷年資料及未完成檢查草稿；結果不會上傳 Supabase。
- 可設定的超音波項目、診間統計、設備清除回報與 Phase 2 Bridge 介面。

> 未設定 Supabase 時，首頁顯示「尚未設定雲端」且無法登入。正式工作資料必須先經 Supabase Auth 登入並確認帳號頁面權限；導覽、資料庫 RLS 與 RPC 都依同一份權限限制操作。

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
3. 由管理者在 Authentication → Users 手動建立工作人員帳號，再到 Table Editor → `staff_permissions` 勾選工作頁面權限，詳見下方「帳號頁面權限」。登入維持 email/password；本功能不調整目前 Email confirmation 設定，也不新增公開註冊或其他登入流程。
4. 複製 `.env.example` 為 `.env.local`，填入 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`。不要使用 service role。

Migration 會建立資料表、交易式 RPC、RLS、明確 GRANT 與 Realtime publication。`anon` 沒有作業資料表權限；`authenticated` 還需有效的 `staff_permissions` 才能讀取工作資料，寫入依功能檢查對應頁面權限。瀏覽器端仍只使用 Publishable/anon key，由登入 JWT 配合 RLS 與 RPC 檢查放行。`participants` 不含身分證欄位，完整公司大名單只存在報到站的 IndexedDB。

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

### 公司大名單更新與現場新增

第一次匯入公司大名單會直接保存並鎖定。已有大名單時，解鎖並選取新 Excel 後會先顯示更新預覽，預設「增量更新」：以完整工號精確新增或更新，保留未出現在新檔案的人員；可選欄位的空白院內分機會保留舊值。`00125` 與 `125` 是不同工號。檔案中的重複工號及缺少必要資料會阻止匯入；更新成功後重新鎖定。「整份取代」需要明確確認，會移除未列入新檔案的人員；預覽取消不會修改名單。

標準模式報到站掃描完整身分證後，先查本機今日排程。若沒有排程但公司大名單有唯一匹配的人員，會直接開啟「加入今日排程」，只需確認時段即可加入並報到；兩份名單都查不到時，會開啟「新增受檢者」，自動帶入身分證並固定目前場次日期。可選擇同時加入公司大名單，其鎖定狀態維持原樣。今日雲端名單為空時也可掃描新增。

現場新增只附加一筆本機排程，序號使用目前最大值加一，再單筆建立雲端 participant 並呼叫既有報到 RPC。身分證及包含完整身分證的其他文字欄位不會上傳。工號或身分證衝突會阻止操作；雲端唯一鍵衝突會取得並核對既有人員，不覆蓋其報到編號、時段或狀態。網路失敗時不會宣告成功：已保存的資料保留供重試，重試沿用原本的人員資料與時段；取消後重新掃描也可續接尚未完成的單筆上傳。

## 標準模式與簡易模式

建立場次時可選擇「場次模式」，預設為標準模式，建立後固定模式。標準模式繼續使用每日排程、整理後排程與 A～G 分組流水號；既有場次由 migration 保持為 `standard`，原報到編號、排程、狀態與檢查紀錄不重新編號。

簡易模式直接使用同一份本機 Company Master，以身分證或完整工號的 IndexedDB 複合索引查人。查到人只顯示確認卡；按「確認報到」才以 `simple_check_in_participant` 在同一交易內建立 participant 並取得全場 1、2、3 的號碼。沒有每日排程、時段或假的 A 組。只有實際報到人員的工號、姓名、性別、項目與選填分機上傳；完整身分證與大名單留在本機。查無人員時可新增並報到，也可單筆加入已鎖定大名單且維持原鎖定狀態。

控制台、診間、檢查輪次、歷年資料、房態、設備租約、頁面權限及 Realtime 共用目前實作。簡易模式隱藏 A～G／時段和虛構的未報到統計，報到 Excel 只有「今日已報到」。清除／刪除簡易場次會清除該場次雲端參與者、檢查、診間與取號 counter，公司大名單及本機歷年資料保留。

新增 migration 為 `supabase/migrations/202610070005_simple_workflow.sql`；透過既有 GitHub → Supabase Integration 套用，確認成功後再發布相應前端，不需另貼 SQL、建立帳號權限或匯入整份大名單到 Supabase。詳細資料流、schema、回歸證據與測試指令見 [簡易模式說明](docs/simple-workflow.md)。

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
5. PWA shell 可離線開啟；離線或帳號權限同步失敗時，工作頁面會停止顯示並清空記憶體中的工作資料，重新連線確認權限後再載入。雲端既有檢查狀態與本機歷年資料保留；正式完成必須等 Supabase 成功回覆，不可在離線時宣告完成。

## 結束場次與資料生命週期

具有 `can_registration` 的工作人員才能執行清除排程、刪除／關閉場次及設備清除回報。設備清除 service 先確認目前登入者與報到站權限，再只清理本機檢查草稿，保留歷年醫療資料；本機清除失敗不送出 acknowledgment。`close_health_session` 有尚未回報的設備清除要求時會保留 pending，不會宣告雲端清除完成。

`DELETE` 只清除此應用的線上作業資料與在線瀏覽器資料，**不代表 Supabase 備份、WAL、瀏覽器備份或實體媒體立刻且不可復原**。保留期限、備份刪除及裝置退役須依院方與 Supabase 方案另訂政策。本系統不會刪除院方原正式健檢系統。

## 安全注意事項

- 不提交正式個資、Excel 或 `.env`；身分證只保存在報到站本機 IndexedDB 與使用者主動匯出的完整 Excel，不寫入 Supabase、`note`、JSON、其他文字欄位、console 或 error log。
- RLS 與 RPC 內的頁面權限檢查共同限制操作，按鈕隱藏不是授權。Supabase Auth 登入後，還需 `is_active = true` 與對應頁面權限；管理者可在 `staff_permissions` 取消權限或停用帳號。
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

## 診間「暫時離開」

「超音波診間」的「開始檢查」右側新增黃色「暫時離開」按鈕；離席後變為「返回診間」。診間、控制台與報到站都從 Supabase 的正式診間狀態顯示黃燈及「暫時離開」。這是獨立的不可接人狀態，並非空閒、完成或關閉。

既有 schema 沒有診間狀態欄位，因此 `202610070001_room_away.sql` 新增 `public.rooms(session_id, room_id, status, updated_at)`，以 `(session_id, room_id)` 隔離場次與診間；`status` 使用 `public.room_status` 的 `idle`、`in_progress`、`away`。沒有新增前態、病人資料或離席原因欄位。返回時從既有未完成檢查推導 `in_progress` 或 `idle`。

請透過既有 Supabase migration 部署流程套用此新增 SQL，再發布相應前端；勿修改或重貼原 migration。新診間狀態表僅允許已授權工作人員讀取，寫入使用 `set_room_away(p_session_id, p_room_id, p_away)`，並要求 `can_room`。原開始／完成 RPC 以同一診間資料列鎖阻擋離席操作與同診間重複接人。既有進行中檢查會回填房態，清排程／刪受檢者會釋放一般診間而保留離席狀態。

按下離開／返回僅修改房態，保留查詢、受檢者、歷年資料、選擇項目、原檢查時間與確認操作。切換診間時，尚在此頁面的工作畫面依場次與診間暫存，不相互覆蓋。重新整理／其他裝置重新讀取持久化房態及既有進行中檢查；未開始的完整查詢畫面不會上傳雲端。歷年資料與草稿維持原本機保存方式。

`rooms` 納入 Realtime publication，控制台、報到站與診間訂閱同一場次；重連／切回畫面會重讀。讀取或同步失敗時顯示未確認狀態並阻止開始檢查。系統目前的叫號是共用候檢隊列，尚無指定診間或自動分配；實際指定診間的入口 `start_examination` 會原子排除 `away`。

本次新規格取代 #30 設計。於目前取得的程式及 Git 歷史未找到 #30 實作；控制台原本以受檢者／檢查推導紅綠燈的程式已改為讀取正式診間狀態。

除一般型別、測試與建置外，可用以下指令在可執行 Docker 的開發環境驗證 migration 與真實資料庫競態：

```sh
bash scripts/test-room-away-db.sh
```

此測試僅使用無對外連接埠、無網路的本機 PostgreSQL 17 暫存容器，驗證所有 migration、RLS／GRANT、房態保留、回復、追加檢查與同時開始競態；不連線正式 Supabase。正式發布後仍需兩台登入同一場次的實體平板驗收 Realtime。

## 每個場次的超音波診間數量

場次管理的新增與編輯畫面可設定超音波診間數量，並預覽將啟用的診間。前端統一使用 `src/features/room/config.ts` 的 `MIN_ROOM_COUNT = 1`、`MAX_ROOM_COUNT = 8`、`DEFAULT_ROOM_COUNT = 4`；場次列表與詳細資料也顯示已儲存的數量。

增量 migration `supabase/migrations/202610070002_session_room_count.sql` 在現有 `health_sessions` 加入 `room_count integer not null default 4` 及範圍限制。舊場次補為 4，已有診間狀態與檢查歷史保留。診間 ID 沿用目前的「診間 1」格式，`room_count` 決定有效房號，`rooms.status` 維持 `idle`、`in_progress`、`away` 的即時狀態。

新增場次會在同一資料庫交易內初始化有效診間。增加數量只補上缺少的診間，使用 `ON CONFLICT DO NOTHING`，不會將原有 `away` 或 `in_progress` 重設。編輯透過要求 `can_registration` 的 `update_session_room_count(p_session_id, p_room_count)`，一般 client 不能直接 UPDATE `room_count`：減少時，資料庫鎖定場次並檢查欲停用診間的狀態與尚未完成檢查，任何檢查中、暫時離開或未完成受檢者都會拒絕整筆變更。成功減少後仍保留舊 `rooms` 與完成檢查紀錄。過去日期、正在結束或已結束的場次，其診間數量唯讀。

報到站、控制台、診間選擇器與診間狀態列表依各場次數量產生房號，忽略保留的超範圍診間資料。場次設定透過 `health_sessions` Realtime 同步；重新載入、切換場次與重連時會重讀雲端設定。現有叫號仍為共用候檢隊列；實際指定診間的 `start_examination` 同時限制有效房號、`idle` 且沒有其他進行中檢查，排除 `away`、`in_progress` 及超出 `room_count` 的診間。

沿用既有 GitHub → Supabase Integration：合併至 `main` 後確認此 migration 的 deployment log 成功，再使用新前端。不需另外建立資料表、調整 RLS 或在 SQL Editor 手動貼 SQL。資料庫測試指令與一般驗證：

```sh
npm run typecheck
npm run lint
npm test
npm run build
bash scripts/test-session-room-count-db.sh
```

SQL 測試使用暫存本機 PostgreSQL，不修改正式 Supabase；正式發布後可再用兩台平板驗收實體裝置的 Realtime 同步。

## 帳號頁面權限

每個 Supabase Auth 工作人員帳號使用三個獨立 Boolean 決定可用工作頁面，允許任意組合，不使用固定角色 enum。帳號維持 **email + password** 登入，由管理者在 Supabase Dashboard 建立；PWA 沒有 Sign up、Email 驗證流程、OTP、Magic Link 或第三方登入。本次不修改 Supabase 專案的 Email confirmation 設定，也不需要寄送或接收 Email；合法 Email 格式只作為登入帳號名稱。

### 權限資料與既有帳號

增量 migration `supabase/migrations/202610070003_staff_page_permissions.sql` 新增 `public.staff_permissions`：

| 欄位 | 型別與限制 | 新帳號預設／用途 |
|---|---|---|
| `user_id` | uuid primary key，references `auth.users(id)` on delete cascade | Auth User ID |
| `login_email` | text，可為 null | 複製 Auth Email，方便 Table Editor 辨識 |
| `display_name` | text not null | `''`；可由管理者填寫顯示名稱 |
| `can_registration` | boolean not null | `false`；健檢報到站 |
| `can_console` | boolean not null | `false`；超音波控制台 |
| `can_room` | boolean not null | `false`；超音波診間 |
| `is_active` | boolean not null | `true`；是否啟用本系統存取 |
| `created_at` | timestamptz not null | `now()` |
| `updated_at` | timestamptz not null | `now()`；更新 trigger 維護 |

Migration 當下既有 `auth.users` 會 backfill 為三個頁面權限及 `is_active` **全部 true**，既有工作人員不會因部署被鎖死；若已存在 permission row，`ON CONFLICT DO NOTHING` 保留其原設定，不會重新授予權限。Migration 不修改既有場次、診間數量或檢查紀錄，也不寫死任何 Email。

Migration 後新增的 Auth User，由 `auth.users` trigger 自動建立三個權限 **全部 false**、`is_active = true` 的 permission row，需管理者再授權。Trigger 只讀 Auth 的實際 `id`／`email`，不採信使用者 metadata；後續 Auth Email 修改會同步 `login_email`，保留已設定的權限、名稱及停用狀態。刪除 Auth User 時，其 permission row 隨外鍵 cascade 刪除。

### 新增工作人員帳號

1. 開啟 **Supabase Dashboard → Authentication → Users**。
2. 選擇 **Add user**，輸入合法 Email 格式帳號，例如 `room01@itri.example.com`，並設定 password。
3. 完成建立，沿用專案目前可用的 email/password 與 Email confirmation 設定。
4. 開啟 **Table Editor → public → staff_permissions**，以 `login_email` 找到剛建立的帳號。
5. 視需要填寫 `display_name`，勾選所需的 `can_registration`、`can_console`、`can_room`，確認 `is_active = true` 並儲存。
6. 使用該帳號登入 PWA，確認只出現已授權工作頁面。

例如診間帳號 `room01@itri.example.com` 設為 `false / false / true`；控制台帳號可使用 `console01@itri.example.com`，報到站帳號可使用 `checkin01@itri.example.com`。尚未勾選任何權限的新帳號仍可完成 Auth 登入，但只能查看權限提示及登出。

| 帳號用途 | 健檢報到 `can_registration` | 超音波控制 `can_console` | 超音波診間 `can_room` |
|---|---|---|---|
| 全功能工作站 | ✅ | ✅ | ✅ |
| 健檢報到站 | ✅ | ❌ | ❌ |
| 超音波控制台 | ❌ | ✅ | ❌ |
| 超音波診間 | ❌ | ❌ | ✅ |
| 現場主管 | ✅ | ✅ | ❌ |

此表為使用範例，三個 Boolean 仍可設定其他任意組合。停用帳號請將 `is_active` 改為 false；恢復啟用後仍使用原本的三個權限設定。

### RLS、欄位授權與 RPC

`is_active_staff()`、`can_use_registration()`、`can_use_console()`、`can_use_room()` 均以 `auth.uid()` 查詢目前帳號的 permission row，使用 `SECURITY DEFINER`、`STABLE` 與空 `search_path`，不接受前端 user_id 作為授權依據。`can_access_session(p_session_id)` 要求場次存在、帳號啟用且至少有一個工作頁面權限，只代表必要場次的共用讀取權限，不代表可修改資料。

- **共用 SELECT**：啟用且至少有一個頁面權限的帳號，可讀取工作所需的 `health_sessions`、`participants`、`examinations`、`rooms` 與項目目錄；無任何頁面權限或已停用帳號無法讀取這些工作資料。
- **健檢報到站**：`can_registration` 才能建立／管理場次、匯入及修改基本排程、新增／刪除 participant、報到、清除排程、關閉／刪除場次及執行設備清除管理。Client 的 INSERT／UPDATE 只授予現有 service 必要欄位；不能直接修改 participant 的 workflow status、報到號／時間、叫號時間或場次 `status`／`room_count`。
- **超音波控制台**：`can_console` 才能透過指定 RPC 叫號或修改等候狀態，沒有整張 `participants` 的 UPDATE 權限。
- **超音波診間**：`can_room` 才能開始／完成檢查、追加檢查、暫時離開／返回診間或讀取檢查時鐘。`rooms` 與 `examinations` 對一般 client 僅開放 SELECT，狀態寫入必須使用 RPC。

下列工作 RPC 的函數內均明確檢查頁面權限，直接呼叫 Supabase API 也不能跳過；設備租約相關 RPC 另見下方。原有交易鎖、重試冪等、伺服器時間、追加 round、房數安全檢查及歷史保留邏輯維持：

| RPC | 必要頁面權限 | 操作 |
|---|---|---|
| `check_in_participant` | `can_registration` | 報到及流水號 |
| `update_session_room_count` | `can_registration` | 安全調整診間數量 |
| `clear_session_schedule` | `can_registration` | 清除今日排程 |
| `delete_health_session` | `can_registration` | 刪除場次 |
| `close_health_session` | `can_registration` | 關閉場次及雲端清除 |
| `acknowledge_device_clear` | `can_registration` | 設備清除回報 |
| `set_waiting_status` | `can_console` | 等候狀態 |
| `call_participant` | `can_console` | 叫號 |
| `start_examination` | `can_room` | 開始檢查 |
| `complete_examination` | `can_room` | 完成檢查 |
| `enqueue_additional_examination` | `can_room` | 追加 examination round |
| `set_room_away` | `can_room` | 暫時離開／返回診間 |
| `examination_clock` | `can_room` | 伺服器檢查時鐘 |

所有上述權限也要求 `is_active = true`；修改類 RPC 在 `SECURITY DEFINER` 內檢查，`examination_clock` 是同樣檢查 `can_room` 的 `SECURITY INVOKER`。開始／完成及離開／返回還需證明本機持有該診間的有效租約。舊版不驗設備租約的 overload 已退役，內部 trigger／房號 helper 不授予一般 client EXECUTE。

控制台既有「追加檢查」入口屬於診間操作，所以在控制台使用該按鈕需同時具備 `can_console` **及** `can_room`；console-only 可叫號及調整候檢狀態，但看不到追加按鈕，也不能直接呼叫追加 RPC。room-only 可呼叫追加 RPC，也可在診間開始／完成已排隊的追加 round；目前建立追加項目的 UI 入口仍位於控制台。

`staff_permissions` 啟用 RLS：一般 `authenticated` 只能 SELECT 自己的 row，即使停用或取消全部頁面權限仍可讀自己設定以顯示原因；不授予 INSERT／UPDATE／DELETE，不能替自己或他人授權。`anon` 完全不能讀寫。第一版沒有 PWA 帳號管理介面，權限由管理者透過 Dashboard／Table Editor 管理；前端不新增 service_role／secret key。

資料匯出入口只在已授權的報到站顯示，正在匯出時若頁面卸載或權限重新確認，前端不再觸發下載。各工作頁面需要共用 SELECT 的作業資料仍可由其合法 API 讀取；頁面權限不宣稱能阻止使用者自行另存其可讀資料。

### 登入、權限同步與錯誤提示

App 在 Auth 登入後先載入 `staff_permissions`，確認啟用及可用頁面後才查詢場次／participant 或掛載工作頁面。導覽只列出可用頁面；登入預設依 **健檢報到站 → 超音波控制台 → 超音波診間** 選擇第一個可用頁面，因此 room-only 直接進診間。頁面 Guard 同時檢查 render，舊 page state 或 localStorage 不會開啟未授權頁面。

| 帳號狀態 | 顯示訊息 |
|---|---|
| 沒有 permission row | 此帳號尚未設定系統權限，請洽管理員。 |
| `is_active = false` | 此帳號目前已停用，請洽管理員。 |
| 三個頁面權限全部 false | 此帳號目前沒有可使用的工作頁面，請洽管理員。 |
| 資料庫拒絕功能操作 | 此帳號沒有執行此功能的權限。 |

前三種狀態只提供登出，不載入場次、今日排程、受檢者、診間狀態或 examination。權限讀取／同步失敗也停止工作存取，不使用快取權限繼續放行。帳號切換、權限重新確認或工作存取被取消時，App 清空記憶體工作資料、解除工作訂閱，並忽略先前帳號／場次尚未完成的查詢回應。本機歷年 IndexedDB 的內容、格式及身分證不上雲端的規則維持。

`staff_permissions` 加入既有 `supabase_realtime` publication，前端以目前登入者 `user_id` 訂閱。INSERT／UPDATE 依自己的 SELECT RLS 控制可見資料；事件只觸發重新向資料庫查詢自己的 permission row，不將 payload 當成授權。管理者取消目前頁面權限後，導覽立即更新並切換到下一個可用頁面；取消最後一個權限或停用後停止載入工作資料。

Supabase Postgres Changes 的 DELETE 不套用列級 RLS，刪除通知在 RLS 表只帶主鍵；本表使用預設 replica identity，不傳送被刪帳號的 Email、名稱或權限 flags，但未篩選的訂閱可能收到被刪 row 的 UUID。權限變更管理使用 UPDATE 取消權限或停用；權限 row 被刪除後，重新整理、取得 focus、可見頁籤及重連時重新查詢也會正確拒絕。離線、Realtime 中斷或讀取失敗會暫停工作頁面並清空記憶體工作資料，恢復連線並確認權限後才重新載入。

### 部署與測試

沿用 GitHub → Supabase Integration 的增量 migration 流程。合併到 `main` 後，確認 `202610070003_staff_page_permissions` deployment／migration log 成功，再使用相應前端；不用在 SQL Editor 手動貼 SQL，也不用另外修改 RLS 或登入設定。管理者只需為新帳號在 Table Editor 勾選權限，既有帳號已由 backfill 保持可用。

```sh
npm run typecheck
npm run lint
npm test
npm run build
bash scripts/test-staff-permissions-db.sh
```

只執行權限前端測試可用：

```sh
npm test -- src/test/staff-permissions-service.test.ts src/test/staff-permissions-app.test.tsx src/test/staff-permissions-sync.test.tsx
```

資料庫測試在無網路、無對外連接埠的暫存 PostgreSQL 容器套用全部 migration，驗證既有帳號 backfill、Auth 新帳號／Email trigger、八種 Boolean 組合、停用／缺 row、自己的權限 SELECT、直接 API／欄位寫入拒絕、工作 RPC gate、實際報到／控制台／診間流程與權限取消後的立即拒絕，並執行房態／房數及設備租約回歸與獨立連線競態；不連線正式 Supabase。前端測試涵蓋預設頁面、Guard、拒絕時不載入資料、Realtime／focus／離線及跨帳號舊回應。正式發布後仍需實體平板驗收登入、權限更新及 Realtime 同步。

## 診間設備佔用鎖

同一場次、同一診間同時只能由一台瀏覽器／PWA 持有有效租約。下拉選單顯示「診間 1（本機）」或「診間 2（其他設備使用中）」；其他設備持有的診間不可選取。全部被佔用時停止查詢、選人、檢查及房態操作；等待釋放或逾時後重新選擇。

### 設備識別與資料保存

目前 `registered_devices` 是設備清除流程的 schema，前端尚無穩定設備 ID，因此首次使用以 `crypto.randomUUID()` 建立 `itri-device-id`，另以 `crypto.getRandomValues` 產生 32 bytes 隨機憑證，保存於本機 `itri-device-claim-secret`。重新整理、關閉再開及 PWA 重啟沿用同一份識別；一般畫面不顯示 UUID、Email 或憑證。

增量 migration `supabase/migrations/202610070004_room_device_claim.sql` 在既有 `public.rooms` 加入 `claimed_by_device_id`、`claimed_by_user_id`、`claimed_at`、`claim_expires_at` 及 `claim_secret_hash`，以原 `(session_id, room_id)` 主鍵、完整性 constraint 與設備／期限索引維持單一租約。資料庫只保存憑證的 SHA-256 hash；公開 device UUID 或 hash 都不能代替本機憑證。不同帳號即使使用同一 device ID 也不能替另一個 Auth user 續租。

設備佔用與 `rooms.status` 分開。取得、續租、釋放都不重設 `idle`、`in_progress` 或 `away`；`updated_at` 保持房態時間用途，租約期限由 `claim_expires_at` 記錄。沒有另建第二套診間或設備登錄表，也不修改本機歷年資料、草稿格式或身分證不上雲端的規則。

### 固定租約與原子操作

前端統一設定放在 `src/features/room/claimConfig.ts`：`ROOM_CLAIM_TTL_SECONDS = 180`、`ROOM_CLAIM_HEARTBEAT_SECONDS = 30`、`ROOM_CLAIM_REFRESH_SECONDS = 30`。資料庫 TTL 統一由 `room_claim_ttl_seconds()` 回傳 180；期限使用資料庫時間，前端以伺服器剩餘時間及單調時鐘判定本機期限。

| RPC | 行為 |
|---|---|
| `claim_room` | 鎖定場次與房間，在同一交易判斷空房、過期或本機續接；有效的其他設備租約回 `room_claimed` |
| `switch_room_claim` | 驗證原房所有權，取得目的房後釋放原房；失敗整筆 rollback，原房仍屬本機 |
| `heartbeat_room_claim` | 僅有效租約的 device＋Auth user＋憑證可續租，期限延長至伺服器當下＋180 秒 |
| `release_room_claim` | 僅租約擁有者可釋放；帶入取得時間防止延遲的舊請求清掉新租約，檢查中拒絕釋放 |
| `list_room_claims` | 回傳有效房號的佔用／本機標記、期限及伺服器時間，供選單判斷 |

每個 RPC 都自行檢查 `can_use_room()`、場次、有效房號及需要的所有權；只登入或修改 localStorage 不會取得使用權。一般 client 不能直接 UPDATE claim 欄位。開始檢查、完成檢查及暫時離開／返回也在原有鎖內驗證有效租約，舊版不驗設備的 RPC signature 已移除，不能用直接 API 繞過。

每台設備在同一場次僅能持有一間有效診間，變更必須使用原子切換；不同場次各自隔離。診間數量縮減時，欲停用房間如果仍有有效設備租約也會拒絕，避免移除設備正在使用的房號。過去日期場次不能新增或續租；既有跨日未完成檢查仍可在有效本人租約內依原規則完成，歷史資料維持可讀。

### 離開、斷線與檢查恢復

每 30 秒 heartbeat，`away` 期間也持續續租；暫時離開及返回只變更房態，不釋放租約。檢查中 selector 停用，資料庫也禁止 switch／release，包含房態為 `away` 但仍有未完成檢查的情況。

單次網路失敗顯示同步警告，不立即宣告失去有效租約。權限重新確認或短暫離線時，工作畫面仍依既有 Guard 停止顯示，租約管理保留於 Guard 外，避免普通 focus 或 60 秒斷線意外釋放；重新確認權限後恢復工作畫面。確認撤權、帳號切換或離開診間頁則停止續租。

切換場次、離開診間頁、登出、component unmount 及可處理的 `pagehide` 會嘗試釋放。若檢查中或無法完成釋放，最後一次成功續租後 **180 秒**自然失效；正確性不依賴 unload。背景 visibility 變更不主動釋放，以免 Android 短暫切換應用就失去診間。

租約確定失效後，查詢與診間操作立即停止，要求重新選擇；其他設備取得後，原設備不得續租、完成、離開或返回。異常關機後可由新設備接管過期診間，保留房態與既有進行中 examination，恢復同一筆檢查；原設備的寫入由資料庫擋住。重新開頁時 localStorage 只提供偏好的房號，仍需雲端 claim 成功才能操作。

### 即時同步與驗證

沿用 `rooms` 的 Supabase Realtime，取得／釋放後其他平板會重新讀取 claim；另每 30 秒刷新，因此自然逾時即使沒有資料庫事件，也會在最多約 30 秒內重新判斷可用。重新取得 focus、可見及連線恢復也會重讀；訊息不以 Realtime payload 直接授權。

```sh
npm run typecheck
npm run lint
npm test
npm run build
bash scripts/test-room-device-claim-db.sh
```

自動測試以 fake timers 或直接建立過期租約驗證，不等待三分鐘；資料庫測試包含同帳號多設備競爭、過期接管、續租、切換 rollback、未完成檢查保護、憑證冒用／hash 重放拒絕及權限邊界。測試使用無網路暫存 PostgreSQL，不連線正式 Supabase。

合併到 `main` 後沿用 GitHub → Supabase Integration 套用 `202610070004_room_device_claim`，確認 migration 成功並更新前端；不需在 SQL Editor 額外手動貼 SQL 或設定設備。正式發布後請用兩台實體平板驗收 claim／release 的 Realtime、短暫斷線及檢查恢復。

## Realtime 效能驗證

訂閱範圍、100ms 查詢合併、Excel lazy load，以及可重現的查詢次數／bundle 前後比較，見 [效能紀錄](docs/realtime-performance.md)。此調整沒有新增 migration；既有租約、權限與操作規則維持。
