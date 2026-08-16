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

    [string] $LogFile = (Join-Path $PSScriptRoot 'logs\sync-queue.log'),

    # 每日彙總（一天一列，可直接用 Excel 開）
    [string] $SummaryFile = (Join-Path $PSScriptRoot 'logs\daily-sync-queue.csv'),

    # 設定檔路徑（預設同目錄的 config.json）
    [string] $ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

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
