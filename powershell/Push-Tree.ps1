# =====================================================================
# Push-Tree.ps1 — 作業一：推送目錄樹（每 10 分鐘）
#
# 掃描來源目錄的資料夾結構，轉為 path/parent/name 清單，
# 呼叫 updateTree 覆寫 Sheet 的 TREE 分頁，供手機 PWA 當上傳目錄選單。
#
# 排程：powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本檔路徑>"
#
# ※ 本檔含中文，必須存成 UTF-8 with BOM。
# =====================================================================

[CmdletBinding()]
param(
    # 只同步到指定深度，避免來源目錄過於龐大時 TREE 列數爆增（0 = 不限制）
    [int] $MaxDepth = 0,

    # 掃描時要略過的資料夾名稱
    # node_modules 等開發用目錄動輒上萬個子目錄，掃到會讓腳本看似當掉
    [string[]] $ExcludeNames = @(
        '$RECYCLE.BIN', 'System Volume Information', '.git',
        'node_modules', '.svn', '.vs', 'bin', 'obj', '.idea', '.vscode'
    ),

    # 目錄數超過此值就中止，不推送。
    # 防呆：根路徑設錯（例如指到整個原始碼目錄）時，會把數萬筆無關目錄
    # 推成手機的上傳選單，且掃描本身就要跑很久。
    [int] $MaxDirs = 5000,

    # 掃描過程每處理這麼多個目錄就回報一次進度
    [int] $ProgressEvery = 200,

    [string] $LogFile = (Join-Path $PSScriptRoot 'logs\push-tree.log'),

    # 每日彙總（一天一列，可直接用 Excel 開）
    [string] $SummaryFile = (Join-Path $PSScriptRoot 'logs\daily-push-tree.csv'),

    # 設定檔路徑（預設同目錄的 config.json）
    [string] $ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

. (Join-Path $PSScriptRoot 'Common.ps1')

try {
    $cfg = Get-SnapSyncConfig -ConfigPath $ConfigPath
    $items = New-Object System.Collections.Generic.List[object]

    foreach ($rootName in $cfg.Roots.Keys) {
        $rootFull = $cfg.Roots[$rootName]
        $label = if ($rootName) { $rootName } else { '<預設>' }
        Write-Log -Message "開始掃描：$label → $rootFull" -LogFile $LogFile

        # 多根模式下，根名稱本身也要成為目錄樹的一層（第一層節點）
        if ($rootName) {
            $items.Add(@{ path = $rootName; name = $rootName }) | Out-Null
        }

        if (-not (Test-Path -LiteralPath $rootFull)) {
            throw "根目錄不存在：$rootFull（請檢查 config.json 的 Roots）"
        }

        $prefixLen = $rootFull.Length + 1

        # 逐筆串流處理，不先收集成陣列——目錄很多時才能邊掃邊回報進度，
        # 而不是卡在 Get-ChildItem 裡完全沒有輸出。
        Write-Log -Message "  掃描中…（目錄很多時需要一些時間）" -LogFile $LogFile
        $scanned = 0
        $countThisRoot = 0
        $sw = [Diagnostics.Stopwatch]::StartNew()

        Get-ChildItem -LiteralPath $rootFull -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            ForEach-Object {
            $d = $_
            $scanned++

            if ($scanned % $ProgressEvery -eq 0) {
                Write-Log -Message ("  已掃描 {0} 個、納入 {1} 個（{2} 秒）" -f `
                    $scanned, $countThisRoot, [math]::Round($sw.Elapsed.TotalSeconds, 1)) -LogFile $LogFile
            }

            # 根路徑設錯時及早中止，不要讓使用者等到最後才發現推了一堆垃圾
            if ($items.Count -ge $MaxDirs) {
                throw ("目錄數超過上限 $MaxDirs（掃到 $scanned 個仍未結束）。" +
                       "請確認 config.json 的 Roots 指向照片目錄而非整顆磁碟或原始碼目錄；" +
                       "若確實需要這麼多目錄，請加大 -MaxDirs。")
            }

            $rel = $d.FullName.Substring($prefixLen)

            # 統一分隔符為 /，與 Apps Script、PWA 端一致
            $relPath = $rel -replace '\\', '/'
            $parts = $relPath -split '/'

            # ⚠️ 這裡在 ForEach-Object 內，跳過這一筆要用 return 不能用 continue
            #    （continue 會中斷整條管線，等於漏掉後面所有目錄）
            if ($MaxDepth -gt 0 -and $parts.Count -gt $MaxDepth) { return }

            $skip = $false
            foreach ($p in $parts) {
                if ($ExcludeNames -contains $p) { $skip = $true; break }
            }
            if ($skip) { return }

            # 多根模式：路徑前綴加上根名稱，讓落地時可查回實體路徑
            $fullRel = if ($rootName) { "$rootName/$relPath" } else { $relPath }

            $items.Add(@{
                path = $fullRel
                name = $d.Name
            }) | Out-Null
            $countThisRoot++
        }

        $sw.Stop()
        Write-Log -Message ("  {0}：掃描 {1} 個、納入 {2} 個（{3} 秒）" -f `
            $label, $scanned, $countThisRoot, [math]::Round($sw.Elapsed.TotalSeconds, 1)) -LogFile $LogFile
    }

    Write-Log -Message "合計 $($items.Count) 個目錄，開始推送" -LogFile $LogFile

    # updateTree 是覆寫語意，一次推太多代表根路徑可能設錯
    if ($items.Count -gt 500) {
        Write-Log -Message ("目錄數 {0} 偏多，手機選單會難以操作，請確認根路徑正確" -f $items.Count) `
            -Level 'WARN' -LogFile $LogFile
    }

    if ($items.Count -eq 0) {
        Write-Log -Message '沒有可推送的目錄，結束（不覆寫 TREE 以免清空既有資料）' -Level 'WARN' -LogFile $LogFile
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Skipped = 1; Failed = 0 } `
            -Notes '掃描結果為空，未推送'
        exit 0
    }

    $resp = Invoke-SnapSyncApi -Endpoint $cfg.Endpoint -Method 'POST' -Payload @{
        action = 'updateTree'
        token  = $cfg.AdminToken
        tree   = $items.ToArray()
    }

    Write-Log -Message "推送完成：TREE 已更新 $($resp.count) 列（updatedAt=$($resp.updatedAt)）" -LogFile $LogFile

    Add-DailySummary -SummaryFile $SummaryFile `
        -Stats @{ Runs = 1; Skipped = 0; Failed = 0 } `
        -Notes ("最後推送 {0} 個目錄（{1} 個根）" -f $resp.count, $cfg.Roots.Count)
    exit 0
}
catch {
    Write-Log -Message "執行失敗：$($_.Exception.Message)" -Level 'ERROR' -LogFile $LogFile
    Write-Log -Message $_.ScriptStackTrace -Level 'ERROR' -LogFile $LogFile

    # 失敗也要進彙總，否則「今天沒推成功」在報表上看不出來
    try {
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Skipped = 0; Failed = 1 } `
            -Notes ("失敗：{0}" -f $_.Exception.Message)
    } catch { }
    exit 1
}
