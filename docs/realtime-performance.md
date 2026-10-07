# Realtime 查詢與 Excel 載入效能

本次比較以已合併 PR #33 的 `main`（`c3151bc`）為基線。調整前端資料訂閱與載入方式，沒有新增 migration，也沒有變更畫面、權限模型、房態、報到／檢查規則或 Excel 統計規則。

## 資料來源與刷新範圍

- App 只用 `participants` 訂閱刷新目前場次名單。`health_sessions` 事件刷新場次設定，不再因新的場次物件重抓相同場次的名單。
- Console 自行訂閱 `examinations`，以目前 participant ID Set 判斷 INSERT／UPDATE；只有已知 examination PK 的 DELETE 才刷新。未知 DELETE 保留 tombstone，避免初次查詢的延遲結果復活已刪資料，並且不為其他場次送查詢。
- Console 的查詢 scope 使用排序後的 participant ID signature；相同 ID 的新陣列、排序及 participant 狀態更新均不重抓 examination。
- 診間以工作場次／已確認診間為 scope 還原 examination，並處理目前受檢者的 examination、相關 participant 狀態與該診間進出檢查中的訊號。相同名單 identity 或 heartbeat 不觸發還原查詢，也不重設尚未開始的項目或工作畫面。
- 有效的 `rooms` payload 直接合併該診間的 `status`／`updated_at`，不讀 room count 或整批 rooms。相同房態的 heartbeat 不產生狀態更新；若先前漏掉房態事件，也可從完整 heartbeat payload 補正房態。
- 真正的 `room_count` 改變仍讀取 count＋有效 rooms；缺欄位、DELETE、重連及 focus 等恢復情境保留安全重讀。初次批次讀取中的單房更新會合併進結果，不丟掉其他診間。

## 合併查詢與安全邊界

`createRefreshCoalescer` 每個 controller 只服務一個 scope。一般重複刷新共用目前 promise；Realtime burst 用固定 100ms 視窗聚合，明確操作後可直接刷新並取消尚未開始的 timer。

若真正的資料變更在舊查詢開始後到達，標記 dirty，待原讀取結束後補一次最新讀取。同 scope 不並行開第二個讀取，亦不把 mutation 直接 skip。Focus、online、visibility 與正常 SUBSCRIBED 可共享讀取；已知斷線後恢復則重新確認失效的讀取。

仍保留帳號／場次／診間 scope、request generation、解除訂閱及卸載防護。權限事件當下停止授權，最新 authenticated DB 查詢完成前不套用舊 grant。Realtime payload 不用於授權設備租約；自己的 RPC echo 可以省略額外 claim 清單查詢，租約延長仍由 RPC／DB 回應確認。

TTL 180 秒、heartbeat 30 秒、claim fallback 30 秒、到期接管、憑證、取得時間 fence、未完成檢查與 away 保護均維持。對讀取完成後才收到的新 mutation，仍會重新讀取：僅憑「剛查過」的時間窗無法安全區分另一台平板的新操作。

## 可重現 request count

`src/test/realtime-performance.test.tsx` 使用實際 App、Console、訂閱 routing、房態 hook 與刷新 controller，mock DB service。下表只計算初次載入完成後，事件造成的額外 service 查詢；沒有將必要的 heartbeat RPC 或場次列表查詢計入四欄。

| 情境 | participants 前 → 後 | examinations 前 → 後 | rooms 前 → 後 | room count 前 → 後 |
|---|---:|---:|---:|---:|
| 四個獨立 room heartbeat | 4 → 0 | 4 → 0 | 4 → 0 | 4 → 0 |
| participant status 更新、ID 不變 | 1 → 1 | 1 → 0 | 0 → 0 | 0 → 0 |
| 三個 participant 短時間事件 | 3 → 1 | 3 → 0 | 0 → 0 | 0 → 0 |
| 場次 metadata 更新、room count 不變 | 1 → 0 | 2 → 0 | 1 → 0 | 1 → 0 |
| 叫號操作＋附近 Realtime | 2 → 1 | 2 → 0 | 0 → 0 | 0 → 0 |

同場次單一 examination 完成事件：只讀 examinations 一次，participants 零次。完整完成操作另有 participant status 事件，其必要的名單刷新仍保留。其他場次 examination：上述四種查詢皆零次。叫號測試在推進 100ms timer 之前已看到新狀態；房態 payload 直接更新紅／綠／黃燈。

`room-claims-sync.test.tsx` 另量測 `getRoomClaims`：首次初始化由兩次降為一次；四個本人 heartbeat echo 不增加清單查詢；三個其他診間認領事件合併成一次；focus／visible／online／SUBSCRIBED burst 只讀一次並續租一次。權限、房態、examination 的 dirty trailing、斷線恢復、未知 DELETE 及跨 scope 延遲回覆另有回歸測試。

```sh
npm test -- src/test/realtime-performance.test.tsx src/test/realtime-scopes.test.ts src/test/refresh-coalescer.test.ts src/test/console-rooms.test.tsx src/test/room-away-ui.test.tsx src/test/room-state-sync.test.tsx src/test/room-claims-sync.test.tsx src/test/staff-permissions-sync.test.tsx
```

基線可在 repository 外建立 `git archive c3151bc` 副本，使用相同依賴與設定，放入同一份整合測試再執行；其 request count assertion 會如上表失敗。副本應放在 repository 外，避免 Vitest 將副本測試一起遍歷。

## Excel code splitting

`xlsx` 原先經 App 的報表匯出、RosterManager 的匯入／匯出，以及 UltrasoundRoom 的純結果顯示 helper 三條 static import 路徑進入主程式。現在名單 Excel action、主動報表匯出及歷年檔案解析才 dynamic import Excel 模組；純顯示 helper 移至 `history/display.ts`。同步 workbook builder、解析／驗證、IndexedDB index、300 筆 batch、memory hash 與大名單增量規則維持。

匯出仍先重新讀取最新 participants／examinations，且新增的 module await 後再次確認畫面仍有效。Rollup module graph 驗證 `xlsx` 不在主 chunk；HTML 也沒有預載 xlsx chunk。歷年 worker 完全保留原產物。

| 主程式 chunk | Before | After |
|---|---:|---:|
| minified JavaScript | 1,159.23 kB | 730.03 kB |
| gzip（兩者皆 Python gzip level 9） | 360.18 kB | 217.67 kB |

主 chunk 減少約 37.0%，gzip 約 39.6%；xlsx 約 424.50 kB，置於 lazy chunk。數字使用十進位 kB，相同環境及依賴；Vite 自己的 gzip estimate 可能略有差異。

這是主程式解析／執行範圍的縮減，並非整站總下載量下降相同比例。既有 PWA 仍可在背景 precache lazy assets，維持離線檔案功能。主 chunk 仍超過 Vite 的 500 kB warning；React／Supabase 與診間、名單畫面仍保留現有載入架構，沒有為進一步拆分引入新的畫面 fallback 或更改操作流程。

## 部署與驗證

沒有 schema、RLS、Auth 或 Supabase 設定變更，無需手動操作 Supabase。沿用前端 CI／GitHub Pages 部署流程；本 PR 不直接合併 `main`。

```sh
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
bash scripts/test-room-device-claim-db.sh
```

DB wrapper 以暫存 PostgreSQL 執行既有房態、room count、staff permission、room claim、報到／開始／完成／追加、歷史保留與十組獨立連線競態，不連線正式 Supabase。Request mock 與 fake timers 驗證查詢次數及即時更新，並非正式環境網路延遲或十台實體平板 benchmark。

最終本機驗證：TypeScript、lint、build、diff check 全部通過；40 個測試檔共 617 項全部通過（包含原 542 項與 75 項新增回歸）。DB 全套回歸及十組競態也全部通過。
