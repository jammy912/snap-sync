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
    [string[]] $ExcludeNames = @('$RECYCLE.BIN', 'System Volume Information', '.git'),

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

        $prefixLen = $rootFull.Length + 1
        $dirs = Get-ChildItem -LiteralPath $rootFull -Recurse -Directory -Force -ErrorAction SilentlyContinue

        $countThisRoot = 0
        foreach ($d in $dirs) {
            $rel = $d.FullName.Substring($prefixLen)

            # 統一分隔符為 /，與 Apps Script、PWA 端一致
            $relPath = $rel -replace '\\', '/'
            $parts = $relPath -split '/'

            if ($MaxDepth -gt 0 -and $parts.Count -gt $MaxDepth) { continue }

            $skip = $false
            foreach ($p in $parts) {
                if ($ExcludeNames -contains $p) { $skip = $true; break }
            }
            if ($skip) { continue }

            # 多根模式：路徑前綴加上根名稱，讓落地時可查回實體路徑
            $fullRel = if ($rootName) { "$rootName/$relPath" } else { $relPath }

            $items.Add(@{
                path = $fullRel
                name = $d.Name
            }) | Out-Null
            $countThisRoot++
        }
        Write-Log -Message "  $label：$countThisRoot 個目錄" -LogFile $LogFile
    }

    Write-Log -Message "合計 $($items.Count) 個目錄，開始推送" -LogFile $LogFile

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
