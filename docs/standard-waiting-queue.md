# 標準模式候檢順位

此功能只適用 `workflow_mode = 'standard'`。簡易模式仍以既有數字取號排序。

`checked_in_at` 沿用標準報到 RPC 的 PostgreSQL `now()`；前端不傳現在時間。以該 timestamp 轉換成 `Asia/Taipei` 後分類 A～G，07:30 前算 A、11:00 起算 G。effective group 取原排程組別與實際報到組別較後者，因此準時保留原組、遲到加入實際到場時段、提早到場保留原排程。時間經過或設備時鐘錯誤都不會重新分類。

Base Queue 只包含「等候中」，依 effective group、實際報到時間、`checkin_sequence`、報到號碼數字尾碼、`sequence_no`、ID 排序。最後的 ID 僅確保完全相同資料的順序穩定。PostgreSQL 的排序 key 保留微秒精度；缺漏舊值排在有效值後。資料庫時段 snapshot 來自既有 `SLOT_GROUP`，parity test 會阻止兩端定義無聲漂移。

## 提早安排與自然遞補

依本次需求澄清，以自然遞補範例為準，不在每次讀取時重新保護 Base Queue 前三名。

工作人員只能對目前最終順位大於 3 的等候者提早安排。RPC 記錄 server `clock_timestamp()` 至 `promoted_at`，以及一份私有的 `promoted_after_key` 插入邊界。此邊界取當下前三位一般候檢者的最大 Base key，並繼承先前仍等候的提早安排者的邊界。它不代表永久前三名或進入等候區的權限。

共用 SQL 先建立目前 Base Queue，再依 `promoted_at` 重播安排，把該人放在插入邊界及較早安排者之後。當下前三位會受到保護；多位安排依先後排在一般隊伍前。前方離開等候名單後，原第 4 位自然變第 3 位，不需要額外 RPC。保留邊界值也能在原邊界人員離開時，維持中途新報到者的相對順序。

取消會清空兩欄，恢復該人的正常 Base 位置。較早安排者被取消時，不會把後續安排者一起拖到其原始時段。暫時離開等候名單的安排者不顯示；若返回，依原 server timestamp 重新參與 FIFO。重複安排不改 timestamp，包括已自然遞補進前三的重試。

## 共用排序與安全

控制台 `get_standard_waiting_queue` 與 token 保護的公開 RPC 共用私有 `build_standard_waiting_queue`。公開回應仍只有公司／日期，以及每人的工號、遮罩姓名；瀏覽器用排序後 `index + 1` 顯示順位與前三 badge。

提早安排／取消 RPC 檢查登入、控制台權限、場次存取、標準模式、有效場次及等候狀態。順位讀取 RPC 則允許控制台或診間帳號，登記專用與匿名帳號仍無權呼叫。安排／取消以場次 `FOR NO KEY UPDATE` 序列化，再鎖定目標人員；此鎖和既有報到 FK 的 `KEY SHARE` 相容，不修改報到／叫號 RPC。新欄位無瀏覽器 INSERT／UPDATE grant，私有 helpers 也不授予 `anon` 或 `authenticated` 執行權。

控制台只在「現場優先」使用伺服器順位，保留號碼與診間手動排序。沿用 participants Realtime 更新及 refresh coalescer，不新增訂閱。場次切換及過期回應有隔離；讀取失敗會顯示錯誤與重試；尚未確認順位時，「現場優先」暫不呈現等候列，避免把舊報到號碼誤當正式候檢順序。手動號碼／診間排序仍可使用。

## 部署與驗證

Migration：`202610160001_standard_waiting_queue.sql`。既有兩欄為 null，不改報到時間、號碼、counter、檢查或歷史紀錄。沿用 GitHub → Supabase migration 流程，先部署 migration 再啟用新前端，不需手動回填。既有 `participants_public_waiting_idx` 可限制每場等候者查詢；未增加未經量測的索引。

前端測試涵蓋時段、設備時間偏差、微秒、mapping、RPC payload、控制台操作、場次隔離及排序回歸。`scripts/test-room-away-db.sh` 在無網路的拋棄式 PostgreSQL 17 執行實際 migrations、資料保留檢查、SQL 行為／權限／公開最小回應及並行測試，不使用正式 Supabase credentials。

## 診間選人清單

控制台與診間沿用 `workflow/useWaitingQueue`、共用讀取 service 及排序 helper。標準模式只依同一份伺服器最終順位重排等候者所占的位置，其他狀態的位置與全部既有選項保留。簡易模式整份選單依既有數字號碼排序，再以 sequence／ID 保持與公開 RPC 相同的備援順序。不新增公告序號，也不在診間重寫 effective group 或 promotion 演算法。

participants 的報到、狀態、提早安排等資料更新會讓共用 hook 重新讀取順位，沿用 coalescer 與場次／版本隔離，不增加 Realtime channel。選單只在需要時讀取；已選人、開始／完成檢查、歷年資料、追加檢查與 claim 的原流程不受排序載入影響。未確認或暫缺部分順位時，保留全部選項、提示重試，僅暫停選取未確認的等候者；其他選項及查詢照常使用。

`202610160002_room_waiting_queue_read.sql` 只擴充既有順位讀取 RPC 的頁面權限，讓 room-only 帳號能讀同一份 canonical queue。沒有新增資料欄位，沒有擴大匿名資料或提早安排／取消權限。部署此 migration 後再更新前端，無需資料回填。
