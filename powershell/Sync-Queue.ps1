# =====================================================================
# Sync-Queue.ps1 — 作業二：下載與回收（每 10 分鐘）
#
# 流程：queue 取 pending → download 取 base64 → 寫入本機對應目錄
#      → 驗證寫檔成功 → 才 ack（永久刪 Drive 檔 + 刪 QUEUE 列）
#
# ★★ 最不能妥協的一條：一律「先確認、後刪除」。★★
#    下載或寫檔失敗一律不 ack，留待下一輪重試。
#    若順序顛倒（先刪後驗），下載失敗就等於照片永久遺失——
#    雲端已刪、本機沒有，救不回來。
#
# 排程：powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本檔路徑>"
#
# ※ 本檔含中文，必須存成 UTF-8 with BOM。
# =====================================================================

[CmdletBinding()]
param(
    # 單輪最多處理幾筆，避免一次跑太久卡住排程
    [int] $MaxItems = 200,

    # ⚠️ 預設值不可寫成 (Join-Path $PSScriptRoot ...)：在 [CmdletBinding()] 的
    #    param 區塊裡 $PSScriptRoot 是空字串，Join-Path 會直接拋錯而中止。
    #    留空，改在下方 body 補上（見 Push-Tree.ps1 的相同處理）。
    [string] $LogFile,

    # 每日彙總（一天一列，可直接用 Excel 開）
    [string] $SummaryFile,

    # 設定檔路徑（預設同目錄的 config.json）
    [string] $ConfigPath
)

if (-not $LogFile)     { $LogFile     = Join-Path $PSScriptRoot 'logs\sync-queue.log' }
if (-not $SummaryFile) { $SummaryFile = Join-Path $PSScriptRoot 'logs\daily-sync-queue.csv' }
if (-not $ConfigPath)  { $ConfigPath  = Join-Path $PSScriptRoot 'config.json' }

. (Join-Path $PSScriptRoot 'Common.ps1')

# 防止排程重疊：照片多時單輪可能跑超過排程間隔，
# 兩份同時跑會抓到同一批 QUEUE 項目、寫入同一個檔名互相覆寫。
$lock = Get-SnapSyncLock -Name 'SnapSync-SyncQueue' -LogFile $LogFile
if (-not $lock) {
    Write-Log -Message '上一輪尚未結束，本輪跳過（正常現象，不需處理）' -LogFile $LogFile
    # 記為 Skipped 而非 Failed——這是防呆生效，不是錯誤。
    # 但若持續出現，代表單輪處理時間已超過排程間隔，應拉長間隔或調小 -MaxItems。
    try {
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Skipped = 1 } `
            -Notes '上一輪未結束，本輪跳過'
    } catch { }
    exit 0
}

try {
    $cfg = Get-SnapSyncConfig -ConfigPath $ConfigPath

    Write-Log -Message '查詢待處理佇列…' -LogFile $LogFile
    $queue = Invoke-SnapSyncApi -Endpoint $cfg.Endpoint -Method 'GET' -Payload @{
        action = 'queue'
        token  = $cfg.AdminToken
    }

    $items = @($queue.items)
    if ($items.Count -eq 0) {
        Write-Log -Message '沒有待處理的照片' -LogFile $LogFile
        # 空跑也計入 Runs，才能從彙總看出排程有正常在跑
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Photos = 0; Failed = 0; Bytes = 0 } `
            -Notes '無待處理照片'
        exit 0
    }

    Write-Log -Message "待處理 $($items.Count) 筆，本輪最多處理 $MaxItems 筆" -LogFile $LogFile

    $ok = 0; $fail = 0
    $processed = 0
    $totalBytes = 0
    $lastError = ''

    foreach ($item in $items) {
        if ($processed -ge $MaxItems) { break }
        $processed++

        $id = [string]$item.id
        $tmpPath = $null
        try {
            # --- 1. 解析根名稱 → 實體路徑，並確認未逸出該根（防路徑穿越） ---
            $fileName = [string]$item.fileName

            # 檔名不可含路徑分隔符
            if ($fileName -match '[\\/]') {
                throw "檔名不合法：$fileName"
            }

            $resolved = Resolve-LocalPath -TargetPath ([string]$item.targetPath) -Roots $cfg.Roots
            if ($null -eq $resolved) {
                throw "查無對應的本機根目錄：$($item.targetPath)（請確認 config.json 的 Roots 與目錄樹一致）"
            }

            $rootFull = $resolved.RootDir
            $targetDir = if ($resolved.SubPath) { Join-Path $rootFull $resolved.SubPath } else { $rootFull }
            $fullTargetDir = [IO.Path]::GetFullPath($targetDir)

            if (-not $fullTargetDir.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
                throw "目標路徑逸出來源目錄：$fullTargetDir"
            }

            if (-not (Test-Path -LiteralPath $fullTargetDir)) {
                New-Item -ItemType Directory -Force -Path $fullTargetDir | Out-Null
                Write-Log -Message "建立目錄：$fullTargetDir" -LogFile $LogFile
            }

            $destPath = Join-Path $fullTargetDir $fileName

            # --- 2. 下載 base64 ---
            $dl = Invoke-SnapSyncApi -Endpoint $cfg.Endpoint -Method 'GET' -Payload @{
                action = 'download'
                token  = $cfg.AdminToken
                id     = $id
            }

            $bytes = [Convert]::FromBase64String($dl.data)
            if ($bytes.Length -eq 0) { throw '下載內容為空' }

            # --- 2b. 下載內容校驗 ---
            # 三個 md5 必須全部一致，任一不符或缺漏都不落地：
            #   $queueMd5 上傳當下 Apps Script 存進 QUEUE 的（源頭事實）
            #   $dlMd5    download 當下對 Drive 內容重算的（抓存放期間的變動）
            #   $localMd5 本地對解碼結果算的（抓傳輸與 base64 解碼損毀）
            $queueMd5 = if ($item.md5)      { ([string]$item.md5).ToLower() }      else { '' }
            $dlMd5    = if ($dl.md5)        { ([string]$dl.md5).ToLower() }        else { '' }
            $storedMd5= if ($dl.storedMd5)  { ([string]$dl.storedMd5).ToLower() }  else { '' }

            $md5 = [Security.Cryptography.MD5]::Create()
            try {
                $localMd5 = [BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-', '').ToLower()
            } finally { $md5.Dispose() }

            # 以 QUEUE 存的為準；沒有就退而用 download 回報的 storedMd5
            $expectedMd5 = if ($queueMd5) { $queueMd5 } elseif ($storedMd5) { $storedMd5 } else { '' }

            if (-not $expectedMd5) {
                # 舊資料（加 md5 欄位之前上傳的）沒有可比對的基準。
                # 這種照片無法證明內容正確，落地後就要永久刪除雲端副本，
                # 因此【不處理】留在雲端，由人工決定如何處置。
                throw '此筆無 md5 基準值（md5 欄位加入前的舊資料），不落地以免無法驗證'
            }

            if ($localMd5 -ne $expectedMd5) {
                throw "下載內容校驗失敗：應為 $expectedMd5、實得 $localMd5"
            }

            # Drive 端內容在存放期間被改動的話，這兩個會不一致
            if ($dlMd5 -and $dlMd5 -ne $expectedMd5) {
                throw "雲端內容與上傳時不符：上傳時 $expectedMd5、目前 $dlMd5"
            }

            # --- 3. 寫檔（先寫暫存再改名，避免中途失敗留下半截檔案） ---
            $tmpPath = "$destPath.part"
            [IO.File]::WriteAllBytes($tmpPath, $bytes)
            Move-Item -LiteralPath $tmpPath -Destination $destPath -Force

            # --- 4. 驗證寫檔成功（檔案存在且大小相符）---
            if (-not (Test-Path -LiteralPath $destPath)) {
                throw '寫檔後檔案不存在'
            }
            $written = (Get-Item -LiteralPath $destPath).Length
            if ($written -eq 0) {
                throw '寫檔後大小為 0'
            }
            if ($written -ne $bytes.Length) {
                throw "寫檔大小不符：預期 $($bytes.Length)、實得 $written"
            }

            # --- 4b. 落地校驗：重讀磁碟算 MD5（這一步最關鍵）---
            # 下一步就要永久刪除雲端副本，所以必須確認「磁碟上的內容」正確，
            # 而不只是「記憶體中的內容」正確。磁碟壞軌、防毒軟體改寫、
            # 檔案系統異常都會造成大小相符但內容不同。
            # 一律重讀檔案，不可直接對 $bytes 再算一次——那驗不到寫入結果。
            $diskMd5 = (Get-FileHash -LiteralPath $destPath -Algorithm MD5).Hash.ToLower()
            if ($diskMd5 -ne $expectedMd5) {
                # 壞檔留著會被誤認為已落地，直接刪掉並保留雲端副本重試
                Remove-Item -LiteralPath $destPath -Force -ErrorAction SilentlyContinue
                throw "落地檔案校驗失敗：應為 $expectedMd5、磁碟 $diskMd5（已刪除壞檔，雲端保留重試）"
            }
            Write-Log -Message "  校驗通過 md5=$diskMd5（上傳→雲端→下載→磁碟 四段一致）" -LogFile $LogFile

            # --- 4c. 壓浮水印（該目錄的 .snapsync 有內容才壓）---
            #
            # ⚠️ 一定要放在 MD5 校驗鏈【全部通過之後】。
            #    壓字會改變檔案內容，先壓的話落地校驗必然失敗——
            #    校驗鏈保護的是「下載的原始內容正確」，浮水印是之後的加工。
            #
            # 壓字失敗不影響落地結果：照片已經正確寫入磁碟並驗證過了，
            # 缺浮水印是可補的，為此把照片留在雲端重試反而增加風險。
            # 傳 RootDir：往上找標記檔時不可超出該根，否則會撈到別的案場的資訊
            $wmText = Get-WatermarkText -Dir $fullTargetDir -RootDir $rootFull
            if ($wmText) {
                # 先備份原圖再壓字。浮水印是破壞性加工，字蓋掉的畫面內容
                # 永久消失；日後要重新出圖（換版型、字打錯、要不同浮水印）
                # 沒有原圖就只能回工地重拍。
                # 只有真的要壓字時才備份——不壓字的話落地檔本身就是原圖。
                $bak = Backup-OriginalPhoto -Path $destPath -LogFile $LogFile
                if ($bak) { Write-Log -Message "  原圖已備份：$bak" -LogFile $LogFile }

                if (Add-PhotoWatermark -Path $destPath -Text $wmText -LogFile $LogFile) {
                    Write-Log -Message "  已壓浮水印（$($wmText -split "`n" | Measure-Object | Select-Object -ExpandProperty Count) 行）" -LogFile $LogFile
                }
            }

            # --- 5. 驗證通過，才 ack（永久刪雲端）---
            $ack = Invoke-SnapSyncApi -Endpoint $cfg.Endpoint -Method 'POST' -Payload @{
                action = 'ack'
                token  = $cfg.AdminToken
                id     = $id
            }

            $ok++
            $totalBytes += $written
            Write-Log -Message ("落地成功 {0} → {1}（{2:N0} bytes，driveDeleted={3}）" -f `
                $id, $destPath, $written, $ack.driveDeleted) -LogFile $LogFile
        }
        catch {
            # 不 ack：雲端保留，下一輪重試
            $fail++
            $lastError = $_.Exception.Message
            Write-Log -Message "處理失敗（保留雲端待重試） id=$id：$($_.Exception.Message)" `
                -Level 'ERROR' -LogFile $LogFile

            # 殘留的暫存檔清掉，避免累積
            if ($tmpPath -and (Test-Path -LiteralPath $tmpPath)) {
                Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Log -Message "本輪完成：成功 $ok、失敗 $fail" -LogFile $LogFile

    $note = if ($fail -gt 0) { "最後錯誤：$lastError" } else { '全數落地成功' }
    Add-DailySummary -SummaryFile $SummaryFile `
        -Stats @{ Runs = 1; Photos = $ok; Failed = $fail; Bytes = $totalBytes } `
        -Notes $note

    if ($fail -gt 0) { exit 2 }
    exit 0
}
catch {
    Write-Log -Message "執行失敗：$($_.Exception.Message)" -Level 'ERROR' -LogFile $LogFile
    Write-Log -Message $_.ScriptStackTrace -Level 'ERROR' -LogFile $LogFile

    # 整輪失敗（例如端點打不通）也要進彙總，否則報表上看不出今天斷線過
    try {
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Photos = 0; Failed = 0; Aborted = 1 } `
            -Notes ("整輪中斷：{0}" -f $_.Exception.Message)
    } catch { }
    exit 1
}
finally {
    # exit 會直接結束 process，作業系統本來就會釋放 Mutex；
    # 這裡明確釋放是為了讓「同一個 PowerShell 工作階段連續手動執行兩次」也正常。
    Release-SnapSyncLock -Lock $lock
}
