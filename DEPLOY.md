# 部署與上線程序

實際部署一次跑通的完整流程與踩過的坑。第一次部署照著走，日後重建環境也照著走。

**部署順序不可打亂**：Google → Vercel → PowerShell。每一層驗證通過才做下一層，
否則出錯時無法歸因（一次只動一個變數）。

---

## 環境現況（2026-08-16 已上線）

| 項目 | 值 |
|---|---|
| PWA | https://snap-sync-coral-rho.vercel.app/ |
| Apps Script `/exec` | `https://script.google.com/macros/s/AKfycbxCRp-UKKV4V.../exec` |
| Sheet ID | `11Bin-iFxlGdb8uj2iDed0fJlZBwrqr4BYECKaJsKvTM` |
| Drive 暫存夾 ID | `1q9dk4g1Szsjs5sP3avpIaOe-1PvFlS40` |
| GitHub | https://github.com/jammy912/snap-sync |

`ADMIN_TOKEN` 只存在於 Apps Script 指令碼屬性與內部 `powershell/config.json`，
**不記錄在此文件、不進 repo**。

---

## 第一層：Google（Sheet + Drive + Apps Script）

### 1-1 建立 Sheet 與 Drive 暫存夾

1. 建一份 Google Sheet，從網址取 **Sheet ID**：
   `https://docs.google.com/spreadsheets/d/<這一段就是 SHEET_ID>/edit`
2. 在 Drive 建一個資料夾當暫存夾，從網址取 **資料夾 ID**：
   `https://drive.google.com/drive/folders/<這一段就是 DRIVE_FOLDER_ID>`
   > 網址後面的 `?dmr=1&ec=...` 是追蹤參數，不要複製進去。
   > **不要**直接用「我的雲端硬碟」根目錄。

### 1-2 貼上程式碼

建立獨立的 Apps Script 專案，把 `appsscript/Code.gs` 全部貼上。

### 1-3 設定指令碼屬性

左側**齒輪圖示「專案設定」** → 頁面**捲到最底** → 「指令碼屬性」 → 新增三筆：

| 屬性名稱（左欄） | 值（右欄） |
|---|---|
| `SHEET_ID` | 1-1 取得的 Sheet ID |
| `DRIVE_FOLDER_ID` | 1-1 取得的資料夾 ID |
| `ADMIN_TOKEN` | 一組 32 字元以上的隨機字串 |

填完務必按 **「儲存指令碼屬性」**。

> ⚠️ **踩過的坑：名稱與值填反了。**
> 症狀是錯誤訊息 `指令碼屬性未設定：11Bin-iFxlGdb...`——訊息裡出現的是你的 ID
> 而非 `SHEET_ID`，就代表左右欄顛倒。**左欄是程式碼寫死的固定名稱，右欄才是你的值。**

產生隨機字串：

```powershell
$chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32; $rng.GetBytes($bytes)
($bytes | ForEach-Object { $chars[$_ % $chars.Length] }) -join ''
```

### 1-4 啟用進階 Drive 服務

左側「**服務**」（加號圖示）→ 找 **Drive API** → 版本 **v3** → 新增。
**識別碼必須保持預設的 `Drive`**。

> ⚠️ **最花時間的坑（實際卡了數輪）**：漏掉這步，系統表面上一切正常——
> 上傳成功、QUEUE 正常清空——但 `ack` 回傳 `"driveDeleted": false`，
> **照片永遠留在 Drive 不斷累積**，15GB 遲早爆掉，且錯誤被 catch 吞掉不會告警。
>
> 判斷方法：`ack` 的回應看 `driveDeleted` 欄位；LOG 分頁會有
> `ACK_DRIVE_FAIL ... ReferenceError: Drive is not defined`。
>
> 診斷工具：編輯器執行 **`diagnoseDrive()`**，它會分辨「沒啟用／識別碼錯／版本非 v3」
> 三種情況，並實際建檔再刪來證明刪得掉。

### 1-5 執行 setupSheets()

上方函式下拉選 **`setupSheets`** → 執行。首次會跳授權：
檢閱權限 → 選帳號 → 「進階」 → 「前往…（不安全）」 → 允許。

會建立五個分頁：TREE / QUEUE / USERS / SESSIONS / LOG。

> 這步不能省。它會把 USERS 的 password 欄設為純文字格式；
> 漏掉的話**純數字密碼會被 Sheet 轉成數字、開頭的 0 消失**，
> 症狀是「密碼明明對卻登不進去」。

### 1-6 建立帳號

在 `USERS` 分頁填入：

| username | password | rootPath | displayName | active |
|---|---|---|---|---|
| `test` | `abc123` | （留空＝全部目錄） | 測試 | `TRUE` |
| `wang` | `xxx` | `專案A` | 王小明 | `TRUE` |

- `rootPath` 決定該使用者看得到哪個子樹，留空代表全部。
- `active` 設 `FALSE` 即時停用該帳號所有 token（**手機遺失時的止血閥**）。

### 1-7 部署

部署 → 新增部署作業 → **網頁應用程式**
- 執行身分：**我**
- 存取權：**任何人**

記下 `/exec` 網址。

> ⚠️ **每次改完 Code.gs 都要「管理部署作業 → 編輯（鉛筆）→ 版本：新版本」**，
> 否則 `/exec` 仍跑舊碼。這是 Apps Script 最常見的除錯陷阱。
> 指令碼屬性與進階服務的變更**不需要**重新部署。

### 1-8 驗證雲端層（不需前端）

用 PowerShell 直接打端點。**12 項全過才往下做**：

```powershell
$u = '<你的 /exec 網址>'
$admin = '<ADMIN_TOKEN>'

# 1. login 正確帳密 → 應拿到 token
$b = '{"action":"login","username":"test","password":"abc123"}'
$r = (Invoke-WebRequest $u -Method Post -Body $b -ContentType 'text/plain;charset=utf-8' -UseBasicParsing).Content
$r; $t = ($r | ConvertFrom-Json).token

# 2. login 錯密碼 → 應回「帳號或密碼錯誤」（與帳號不存在同一訊息）
# 3. tree 帶 session token → 應回目錄樹
(Invoke-WebRequest "$u`?action=tree&token=$t" -UseBasicParsing).Content
# 4. 權限分離：session token 打 queue → 應被拒
# 5. 權限分離：ADMIN_TOKEN 打 tree → 應被拒
```

上線前必驗的關鍵項目：

| 驗證 | 預期 |
|---|---|
| `upload` 到不在 TREE 的路徑 | `UNKNOWN_PATH` 拒絕 |
| `upload` 路徑穿越 `專案A/../../etc` | `BAD_PATH` 拒絕 |
| `upload` 空路徑 | `BAD_REQUEST` 拒絕 |
| 同一個 id 重送 | `duplicated:true`，QUEUE 不增列 |
| **`ack` 後 `driveDeleted`** | **必須是 `true`** |

> `updateTree` 的欄位名是 **`tree`** 不是 `items`；`ack` 是 **`id`** 不是 `ids`。
> （測試時踩過，會回 `BAD_REQUEST`。）

---

## 第二層：Vercel

1. 匯入 GitHub repo。
2. Settings → **Build and Deployment**：
   - Build Command：`node scripts/build-config.js`
   - Output Directory：`public`
3. Settings → **Environment Variables**：
   - Key：`APPS_SCRIPT_URL`
   - Value：第 1-7 步的 `/exec` 網址
   - Environments：Production / Preview / Development **三個都勾**
4. 部署。

### 驗證

```powershell
# config.js 應含正確的 endpoint
(Invoke-WebRequest 'https://<你的網址>/js/config.js' -UseBasicParsing).Content
```

> ⚠️ **改了環境變數必須重新部署才生效。**
> 純靜態網站無法在 runtime 讀環境變數，`config.js` 是 build 時產生的。
> 重新部署：Deployments → 最新那筆「⋯」→ Redeploy
> （建議取消勾選 Use existing Build Cache）。

---

## 第三層：PowerShell（內部 Windows）

### 3-1 建立設定檔

複製 `powershell/config.sample.json` 為 `powershell/config.json`：

```json
{
  "Endpoint": "https://script.google.com/macros/s/<部署ID>/exec",
  "AdminToken": "<與指令碼屬性 ADMIN_TOKEN 相同>",
  "Roots": {
    "專案A": "D:\\工地照片\\專案A",
    "專案B": "D:\\工地照片\\專案B"
  }
}
```

- `Roots` **左邊是目錄樹第一層的名稱**（會成為手機上看到的第一層），右邊是實體路徑。
- 只有單一路徑時可改用 `"RootDir": "D:\\工地照片"`（不加根名稱前綴）。
- `config.json` 已列入 `.gitignore`，**絕不進 repo**。

### 3-2 手動各跑一次

```powershell
cd C:\ASVT\SourceCode\AI\snap-sync\powershell
.\Push-Tree.ps1     # 掃描本機目錄 → 推上 TREE 分頁
.\Sync-Queue.ps1    # 下載 QUEUE 的照片 → 落地 → 驗證 → ack
```

### 3-3 註冊排程

工作排程器建兩個觸發器，**每 10 分鐘、錯開起始時間**（例如整點與整點過 5 分），
降低同時打端點：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ASVT\SourceCode\AI\snap-sync\powershell\Push-Tree.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ASVT\SourceCode\AI\snap-sync\powershell\Sync-Queue.ps1"
```

---

## 上線前最終驗證（端到端）

依序做完，全過才算上線：

1. **手機開 PWA** → 登入 → 看得到目錄樹 → 選目錄 → 拍照。
2. **雲端**：Sheet 的 QUEUE 分頁出現該列、`note` 是 displayName、Drive 暫存夾出現檔案。
3. **等一輪排程**（或手動跑 `Sync-Queue.ps1`），確認**四件事**：
   - 本機 `<實體路徑>\<targetPath>\<檔名>` 檔案存在且**開得起來**
   - QUEUE 該列已消失
   - Drive 暫存夾已空
   - **Drive 垃圾桶為空**（確認是永久刪除，不是丟垃圾桶——垃圾桶仍佔配額 30 天）
4. **權限隔離**：建 `userA`(rootPath=`專案A`)，用它的 token 直接打 `upload`
   並把 `targetPath` 指向 `專案B` → **必須被拒絕**。
5. **撤銷**：把 userA 的 `active` 改 `FALSE` → 用原 token 打 `tree` → **應被拒**。
6. **離線重送**：手機開飛航模式拍 3 張 → 恢復連線 → QUEUE 應**只有 3 列**（冪等有效）。
7. **失敗路徑**：把落地目錄設唯讀 → 跑 `Sync-Queue.ps1` → 確認**沒有 ack**
   （QUEUE 列與 Drive 檔都還在）→ 恢復權限 → 下一輪成功落地。

> 第 7 項是整套系統最不能妥協的設計：**先確認、後刪除**。
> 若順序顛倒，下載失敗就等於照片永久遺失。

---

## 選用：固定存取參數 `k`

擋掉「拿到網址就亂打」的掃描器。**建議等上述全部跑通後再加**，
否則多一個變數會干擾除錯。

**要設就兩邊都設，值必須一致：**

| 位置 | 值 |
|---|---|
| Apps Script 指令碼屬性 `ACCESS_KEY` | `<亂數>`（不含 `?k=`） |
| Vercel 環境變數 `APPS_SCRIPT_URL` | `https://.../exec?k=<同一組亂數>` |

- 只設 Vercel 沒設 Apps Script → 不檢查，形同沒加。
- **只設 Apps Script 沒設 Vercel → 所有人登不進去。**
- 兩邊都不設 → 功能停用（向下相容）。

PowerShell 端**不需要**帶 `k`，內部端點靠 `ADMIN_TOKEN` 把關。

> ⚠️ 參數名**不可用** `token`、`action`、`id`——同名時 Apps Script 取第一個值，
> session token 會被蓋掉，症狀是所有人登不進去、訊息卻顯示「請重新登入」。
> `build-config.js` 會在 build 階段擋下這種設定。

> ℹ️ `k` 會被 build 進前端 `config.js`，**開 DevTools 就看得到**。
> 它是擋雜訊用的，**不是身分驗證**。真正的存取控制仍是 session token 與 `ADMIN_TOKEN`。

---

## 日常維運

### 改了程式碼要做什麼

| 改動位置 | 需要的動作 |
|---|---|
| `appsscript/Code.gs` | 重貼編輯器 → **部署新版本**（否則跑舊碼） |
| `public/**` | push 到 GitHub，Vercel 自動部署，**並把 `sw.js` 的 `CACHE` 版本號 +1** |
| Vercel 環境變數 | **必須手動 Redeploy** |
| 指令碼屬性 / 進階服務 | 即時生效，不必重新部署 |
| `powershell/**` | 直接生效，下一輪排程即採用 |

### 查問題看哪裡

| 現象 | 先看 |
|---|---|
| 手機登不進去 | Sheet 的 LOG 分頁 `LOGIN_FAIL`；確認 USERS 的 `active` 是 `TRUE` |
| 照片沒落地 | `powershell/logs/sync-queue.log`；QUEUE 列還在代表沒 ack（正常保護） |
| Drive 一直長大 | `ack` 的 `driveDeleted` 是否為 `false` → 執行 `diagnoseDrive()` |
| 排程有沒有在跑 | `powershell/logs/daily-sync-queue.csv` 的 `Runs` 欄（含空跑也會累加） |
| 前端報「端點未設定」 | Vercel 的 `APPS_SCRIPT_URL` 沒設或沒重新部署 |
| 手機還是舊版畫面 | `sw.js` 的 `CACHE` 版本號沒加；手機**完全關掉 PWA 再開** |
| 佇列數字一直不動 | 已修（`queue.js` 的 `tick()`）；若復發先確認手機拿到的是新版前端 |

### 帳號管理

- **停用**：USERS 該列 `active` 改 `FALSE`，下一次請求即失效。
- **踢掉單一裝置**：刪 SESSIONS 對應列。
- **清理過期 session**：執行 `cleanupSessions()`（可另設每日觸發器）。

---

## 已知取捨

- **密碼明碼存於 USERS 分頁**——已確認接受。請將 Sheet 共用權限**只留擁有者**。
  日後改雜湊只需替換 `verifyPassword` 與一次性轉換既有列。
- **session token 有效期 3650 天**，等同永不過期。撤銷手段見上方「帳號管理」。
- **Apps Script 取不到來源 IP**（請求經 Google 邊緣轉送），故無法做 IP 級封鎖；
  `login` 改以帳號為鍵做速率限制（10 分鐘內失敗 10 次暫時鎖定，10 分鐘後自動解鎖）。
