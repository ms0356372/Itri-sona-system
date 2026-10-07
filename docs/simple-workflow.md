# 場次簡易模式

## 使用流程

新增場次時選擇模式，預設「標準模式」。第一版的模式在建立後不可修改，空場次也適用；診間數仍透過既有安全檢查編輯。

| 模式 | 報到來源 | 號碼 | 管理／報到匯出 |
| --- | --- | --- | --- |
| `standard` | 大名單 → 每日排程 → 整理後排程 → 雲端今日名單 | 各組 A1、A2、B1… | 今日排程、已報到、未報到與原 Excel |
| `simple` | 本機公司大名單 → 查人 → 確認報到 | 每場次 1、2、3… | 已報到、已完成；只有今日已報到 sheet |

簡易報到的身分證與工號查詢只讀本機大名單。查到人後顯示姓名、工號、性別、項目及選填分機，按「確認報到」才取號。查無時顯示「公司大名單查無此受檢者。」並提供人工新增。人工新增不建立每日排程；可勾選單筆加入公司大名單，既有鎖定設定保持不變。

重複掃描已報到的人員會顯示原號碼與目前狀態；伺服器也冪等處理快取尚未更新或跨設備的重複操作。網路錯誤保留確認資料／人工表單供重試，成功報到後的名單刷新失敗不會把成功改成未報到。場次／公司切換、離開頁面或關閉場次會阻止晚到查詢覆蓋畫面。開啟人工新增也取消先前的掃描查詢。

## Schema 與 migration

增量 migration：`supabase/migrations/202610070005_simple_workflow.sql`。

- `health_sessions.workflow_mode text not null default 'standard'`，限制 `standard`／`simple`。既有場次讀到 `standard`，前端對缺省／null 模式也回退標準模式。資料庫 trigger 禁止建立後切換模式。
- `participants.queue_number integer`，正數或 null，`(session_id, queue_number)` 唯一。標準 participant 為 null，不改原有欄位內容。
- `participants.group_code` 與 `schedule_slot` 可為 null，但 trigger 依場次模式驗證：新的標準排程仍需要原組別／時段；簡易 participant 必須是真正 null，不能用假的 A 組或任意時段。
- `simple_queue_counters(session_id uuid primary key, next_number integer not null default 1)`，session FK cascading deletion。此表啟用 RLS，瀏覽器沒有直接讀寫權限，也不加入 Realtime publication。

migration 不修改舊 `checkin_no`、`group_code`、時段、狀態、檢查、房態或 `group_counters`，不重新編號。舊格式排程的純狀態更新不重新驗證時段，保持既有資料可以繼續操作。

由目前 GitHub → Supabase Integration 套用尚未執行的 migration。確認部署 log 成功後再發布相應前端。此 PR 不操作正式資料庫，也不需額外手動 SQL、權限欄位或設定。若 Integration 停用，依 README 修復既有部署流程。

## 原子取號與身分核對

`simple_check_in_participant(p_session_id, p_employee_no, p_full_name, p_gender, p_item, p_extension)` 要求有效帳號的 `can_registration`，以及 `active` 的簡易場次。

1. 先驗證必填欄位，取得場次 `FOR SHARE` 鎖，與清除／關閉／刪除互斥。
2. 首次建立 counter，必要時從此場次已存在的 `queue_number` 恢復下一號；鎖定 counter 資料列。
3. 在取得 counter 鎖後，以 `(session_id, employee_no)` 查既有 participant。姓名／性別不符則拒絕；符合則直接回傳原完整資料，不改號碼、時間、方案、狀態或 examinations。
4. 新人員才增加 counter，並插入 participant：`sequence_no = queue_number`、`checkin_no = queue_number::text`、`planned_items = [item]`、分機使用既有 `note`，伺服器時間與狀態「等候中」。

整個 RPC 是同一資料庫交易，插入失敗會回滾 counter。不同設備的請求以 counter 鎖序列化；相同人員並發只建立一筆、消耗一號。不使用 `group_counters`，因為簡易模式沒有 A～G 的資料語意。

## 本機索引與雲端邊界

Company Master 沿用 `rosterDb.masterPeople`、公司名稱正規化、增量更新／整份取代與鎖定機制。Dexie v7 增加 `[companyKey+nationalId]` 複合索引，沿用 `[companyKey+employeeNo]`；升級保留人員 ID、排程及鎖定，只正規化身分證格式。

每次掃描透過指定複合索引精確查詢，最多取兩筆以偵測歧義。不呼叫 `getCompanyMaster()` 載入 5,000～10,000 人後再 `Array.find()`。完整大名單只在名單管理匯入／預覽時載入，不因簡易報到而批次上傳。

雲端 service 明確建構上述六個 RPC 參數，沒有物件展開、不包含身分證欄位、活動原文或本機索引資料。操作文字欄若混入完整身分證會阻止上傳，錯誤顯示也會隱藏完整身分證。只有按確認報到的單筆人員建立雲端 participant。

## 共用頁面與生命週期

- `WorkflowCheckin` 只分流報到：標準使用原 `Checkin`，簡易使用 `SimpleCheckin`。標準 `groupForSlot`、每日排程整理、現場新增排程、group counter 與 check-in service 不重寫；SQL 標準報到僅加模式檢查。
- 同一個 Console 在簡易模式隱藏 A～G／組別／時段，以數值 1、2、10 排序；叫號、等待狀態、追加檢查沿用原 RPC。
- 同一個 `UltrasoundRoom` 顯示純數字號碼與「今日名單」，隱藏時段；開始、完成、round 2／3、歷年 IndexedDB、秒數、草稿、room count、away、設備 claim／TTL／heartbeat 沿用原流程。
- 共用 `can_registration`／`can_console`／`can_room`，沒有新頁面權限、第二套登入、PWA 或 room/history database。
- 共用 participants／examinations／rooms／health_sessions Realtime 與現有合併刷新機制，沒有新高頻 polling；heartbeat 不觸發參與者／檢查重讀。
- 場次管理簡易模式顯示公司、日期、模式、診間、已報到／已完成與狀態，隱藏應到／未到統計。
- 簡易報到 Excel 只有「今日已報到」七欄：號碼、工號、姓名、性別、健檢項目、報到時間、目前狀態。號碼為數值，工號保留文字與前導零。標準一參數 workbook API 和原 sheets 不變。
- 超音波 Excel 共用時間／件數／多輪／診間統計，簡易模式移除無意義的排程／未報到欄位，明細使用數字號碼。
- 清除簡易場次會刪除該場次 participants、cascading examinations、rooms／設備租約、counter 與 clearance data；再報到從 1 開始，診間可由原 claim RPC 重建。刪除場次由既有 FK cascade 清理。關閉仍等待必要的設備 acknowledgment，再清理雲端資料。公司大名單與本機歷年資料不在這些清理範圍。

## 驗證紀錄

本 PR 的本機驗證：typecheck、lint、build、`git diff --check` 通過；47 個 Vitest 檔案、724 個測試通過，包含原有 617 個測試。既有測試僅調整場次新增欄位的 query／insert／函式參數期待，以及資料庫 RPC 權限 inventory；標準行為測試沒有大量改寫。

新增覆蓋：模式預設／儲存／重讀／切換、真 null group／slot、5,000 人索引查人、Dexie 升級保留資料、確認後取號、重複報到保留狀態、工號前導零、完整身分證不上傳、查無人工新增／鎖定下單筆新增、雙擊／重試／晚到查詢隔離、Console／Room 分流與 Excel。

資料庫測試使用無對外連接埠、無網路的 PostgreSQL 17 暫存容器，不連線正式 Supabase：

```sh
bash scripts/test-simple-workflow-db.sh
```

此入口共用既有 runner，依序套用全部 migrations，執行房態、room count、staff permissions、device claim、simple workflow 五套 SQL，以及 10 個既有競態和 2 個簡易取號競態。migration 前後先比較每一個既有 business 欄位／資料列完全不變，再讓舊 whole-row snapshot 接受新增的兩個預設欄位。全部通過，包括 A1／A2／B1、獨立 group counters、重複報到、頁面權限矩陣、開始／完成／追加、away／返回／heartbeat、清理隔離及多設備取號。

正式部署後仍需以兩台登入同場次的實體設備驗收實際 Realtime／掃描器；自動測試沒有替代實體平板網路環境。
