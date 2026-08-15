# 工地拍照上傳系統（snap-sync）

現場人員用手機（外網）拍照，照片經 Google 雲端中轉，自動歸檔回內部 Windows 指定目錄。

雲端只當**中轉站**不做長期儲存：照片拉回本機後即永久刪除，因此免費 15GB 帳號可長期穩定運作。

```
[手機 PWA / Vercel]          [Google 雲端]              [內部 Windows]
      │                           │                          │
      │ 1. 登入 ──login──────────►│                          │
      │ 2. 讀目錄樹 ──tree───────►│◄──updateTree── Push-Tree.ps1（每10分）
      │ 3. 拍照上傳 ──upload─────►│                          │
      │                    Apps Script Web App              │
      │                    ├─ Sheet(TREE/QUEUE/USERS/…)     │
      │                    └─ Drive(暫存夾)                  │
      │                           │◄──queue/download── Sync-Queue.ps1（每10分）
      │                           │◄──ack(永久刪除)────      │
```

---

## 三層架構

| 層 | 位置 | 說明 |
|---|---|---|
| PWA 前端 | Vercel（靜態） | 登入、目錄樹選單、拍照壓縮、離線佇列重送 |
| Apps Script | Google | 七個 action 端點，權限驗證與資料存取 |
| PowerShell | 內部 Windows | 推目錄樹、下載回收，兩支排程作業 |

---

## 端點一覽

| action | 方法 | 呼叫者 | 驗證 | 說明 |
|---|---|---|---|---|
| `login` | POST | PWA | 帳密 | 比對 USERS，簽發 session token |
| `tree` | GET | PWA | session | 回傳該使用者子樹（相對路徑） |
| `upload` | POST | PWA | session | 存 Drive + QUEUE 追加一列 |
| `updateTree` | POST | PowerShell | admin | 覆寫 TREE 分頁 |
| `queue` | GET | PowerShell | admin | 回傳 pending 清單 |
| `download` | GET | PowerShell | admin | 依 id 回傳 base64 |
| `ack` | POST | PowerShell | admin | 永久刪 Drive 檔 + 刪 QUEUE 列 |

> **跨域**：PWA 在 Vercel、端點在 Google，屬跨域。Apps Script 不支援 OPTIONS preflight，
> 故 POST 一律以 `Content-Type: text/plain` 送 JSON 字串（CORS simple request）。
> **不可改成 `application/json`**，否則瀏覽器會先送 OPTIONS 而失敗。

---

## 部署步驟

### 1. Google Sheet 與 Drive

1. 建立一份 Google Sheet，記下網址中的 **Sheet ID**。
2. 建立一個 Drive 資料夾當暫存夾，記下 **資料夾 ID**。

### 2. Apps Script

1. 建立獨立的 Apps Script 專案，把 `appsscript/Code.gs` 全部貼上。
2. 左側「服務」→ 新增 **Drive API**（進階服務）。
   > 未啟用會導致 `ack` 報 `Drive is not defined`，雲端檔案會不斷累積。
3. 專案設定 → 指令碼屬性，加入：
   - `SHEET_ID`
   - `DRIVE_FOLDER_ID`
   - `ADMIN_TOKEN`（一組夠長的隨機字串，只給 PowerShell 用）
4. 執行一次 **`setupSheets`** 函式，會自動建立五個分頁並把密碼欄設為純文字格式。
   > 五個分頁（TREE / QUEUE / USERS / SESSIONS / LOG）平時也會自動建立，
   > 但手動執行這次才會設定密碼欄格式——否則純數字密碼會被 Sheet 轉成數字、開頭 0 消失。
5. 在 `USERS` 分頁填入帳號：

   | username | password | rootPath | displayName | active |
   |---|---|---|---|---|
   | `wang` | `abc123` | `工程/專案A` | 王小明 | `TRUE` |
   | `admin` | `xxx` |（留空＝全部目錄）| 管理者 | `TRUE` |

6. 部署 → 新增部署作業 → **網頁應用程式**
   - 執行身分：**我**
   - 存取權：**任何人**
   - 記下 `/exec` 網址。

> ⚠️ **每次改完 Code.gs 都要重新部署新版本**，否則 `/exec` 仍跑舊碼。

### 3. Vercel

1. 匯入本 repo。
2. 設定：
   - **Build Command**：`node scripts/build-config.js`
   - **Output Directory**：`public`
   - **環境變數** `APPS_SCRIPT_URL` = 上一步的 `/exec` 網址
3. 部署，取得 preview URL。

> 純靜態網站無法在 runtime 讀環境變數，故由 build 指令產生 `public/js/config.js`。
> **改了環境變數必須重新部署才生效。**

### 4. PowerShell（內部）

1. 複製 `powershell/config.sample.json` 為 `powershell/config.json`，填入端點、`ADMIN_TOKEN` 與本機路徑。
2. 手動各跑一次確認正常：
   ```powershell
   .\Push-Tree.ps1
   .\Sync-Queue.ps1
   ```
3. 工作排程器建立兩個觸發器，**每 10 分鐘、錯開起始時間**（例如整點與整點過 5 分）：
   ```
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\...\powershell\Push-Tree.ps1"
   ```

---

## 多個本機路徑

`config.json` 的 `Roots` 是「根名稱 → 實體路徑」對應表：

```json
{
  "Roots": {
    "工程": "D:\\工程專案",
    "驗收": "E:\\驗收照片"
  }
}
```

根名稱成為目錄樹第一層：手機上看到 `工程/專案A/區域1`，落地於 `D:\工程專案\專案A\區域1\<檔名>`。

`USERS` 的 `rootPath` 可設 `工程` 限制某人只看得到該根，或設 `工程/專案A` 限制到更細的子樹。

只有一個路徑時也可用舊格式 `"RootDir": "D:\\工程專案"`（不加根名稱前綴）。

---

## 記錄與稽核

| 檔案 | 內容 |
|---|---|
| `powershell/logs/push-tree.log` | 逐行執行記錄 |
| `powershell/logs/sync-queue.log` | 逐行執行記錄（含每張照片落地路徑） |
| `powershell/logs/daily-push-tree.csv` | **每日彙總**：一天一列 |
| `powershell/logs/daily-sync-queue.csv` | **每日彙總**：當日落地張數、失敗數、位元組數 |
| Sheet 的 `LOG` 分頁 | 登入失敗、越權上傳嘗試、ack 異常 |

每日彙總是「今天到底做了什麼」的快速檢視，可直接用 Excel 開：

```csv
Date,Photos,Runs,Failed,Bytes,LastRun,Notes
2026-08-15,42,144,0,18874368,17:50:03,全數落地成功
```

`Runs` 累加每輪執行（含空跑），所以**排程有沒有正常在跑，看這個欄位就知道**。

---

## 可靠性設計

**先確認、後刪除**：一律在本機寫檔成功並驗證大小後，才呼叫 `ack` 永久刪除雲端。
下載或寫檔失敗**一律不 ack**，照片留在雲端等下一輪重試。

> 這是整套系統最不能妥協的一條。若順序顛倒（先刪後驗），下載失敗就等於照片永久遺失。

其他保護：

- **冪等**：每筆以前端產生的 uuid 為鍵，重送不會重複入列。
- **併發控制**：Apps Script 對 QUEUE 的追加與刪除以 `LockService` 上鎖；刪列以 id 比對而非列位置。
- **永久刪除**：用 `Drive.Files.remove()` 而非 `setTrashed`——垃圾桶仍占 15GB 配額。
- **路徑穿越防護**：Apps Script 與 PowerShell 兩端都擋 `..`，並驗證落地路徑未逸出根目錄。
- **權限隔離**：`upload` 在伺服器端驗證 `targetPath` 落在該使用者子樹內**且**命中 TREE 白名單。
  前端過濾只是體驗，伺服器端擋下才是真的隔離。
- **離線佇列**：拍照一律先寫 IndexedDB 再嘗試上傳；失敗保留並以指數退避重送。

---

## 安全性說明（已知取捨）

- **密碼以明碼存於 USERS 分頁**——已確認接受。請將 Sheet 共用權限**只留擁有者**。
  日後要改雜湊，只需替換 `verifyPassword` 相關邏輯與一次性轉換既有列。
- **session token 有效期 3650 天**，等同永不過期。**手機遺失時**把該帳號 `active` 改為
  `FALSE`，下一次請求即失效；若只想踢掉單一裝置，刪 `SESSIONS` 對應列即可。
- `ADMIN_TOKEN` 只存在於內部 `config.json`（已列入 `.gitignore`）與 Script Properties，
  **絕不進 repo、絕不出現在前端**。

---

## 驗證清單

上線前建議依序驗證：

1. **權限隔離**：建 `userA`(rootPath=`工程/專案A`) 與 `userB`(rootPath=`工程/專案B`)。
   以 userA 的 token 直接打 `upload` 並把 `targetPath` 指向專案B → **必須被拒絕**。
2. **撤銷**：把 userA 的 `active` 改 `FALSE` → 用原 token 打 `tree` → **應被拒**。
3. **離線重送**：飛航模式拍 3 張 → 恢復連線 → QUEUE 應**只有 3 列**（冪等有效）。
4. **端到端**：拍照 → Drive/QUEUE 出現 → 等一輪排程 → 確認本機檔案存在可開啟、
   QUEUE 該列消失、Drive 暫存夾已空、且 **Drive 垃圾桶為空**（確認是永久刪除）。
5. **失敗路徑**：把落地目錄設唯讀 → 跑 `Sync-Queue.ps1` → 確認**沒有 ack**
   （QUEUE 列與 Drive 檔都還在）→ 恢復權限 → 下一輪成功落地。
