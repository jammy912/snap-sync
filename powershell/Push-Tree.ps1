# =====================================================================
# Push-Tree.ps1 — 作業一：推送目錄樹（每 10 分鐘）
#
# 掃描來源目錄的資料夾結構，轉為 path/parent/name 清單，
# 呼叫 updateTree 覆寫 Sheet 的 TREE 分頁，供手機 PWA 當上傳目錄選單。
#
# 【標記檔機制】
#   來源磁碟（例如 Z:）動輒上萬個目錄，全部推成手機選單根本沒法選。
#   因此改為「開通制」：現場人員在要用的目錄裡放一個空的 .snapsync 檔，
#   該目錄與其底下所有子目錄才會出現在手機選單上。
#
#     Z:\某案場\115年\8月\.snapsync   → 選單出現「8月」及其底下所有子目錄
#
#   標記可以重疊：父目錄和子目錄各自放標記都有效，不會重複列入。
#   標記目錄的祖先（某案場、115年）會自動補進 TREE，否則選單展不開。
#
#   建立標記檔的方式（現場人員自行操作）：
#     在該資料夾內新增一個文字文件，改名為 .snapsync（結尾不要有 .txt）
#
# 排程：powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本檔路徑>"
#
# ※ 本檔含中文，必須存成 UTF-8 with BOM。
# =====================================================================

[CmdletBinding()]
param(
    # 只同步到指定深度，避免來源目錄過於龐大時 TREE 列數爆增（0 = 不限制）
    [int] $MaxDepth = 0,

    # 標記檔名：只有放了這個檔案的目錄（含其底下所有子目錄）才會進 TREE。
    # 來源磁碟動輒上萬個目錄，全推成手機選單根本沒法選，
    # 所以改由現場人員自己在要用的目錄放一個空檔案來「開通」。
    [string] $MarkerName = '.snapsync',

    # 掃描期間網路磁碟機（Z:）可能瞬斷，整輪重來代價太大，
    # 因此對單一根重試這麼多次後才放棄該根。
    [int] $RootRetry = 3,

    # 掃描時要略過的資料夾名稱
    # node_modules 等開發用目錄動輒上萬個子目錄，掃到會讓腳本看似當掉
    [string[]] $ExcludeNames = @(
        '$RECYCLE.BIN', 'System Volume Information', '.git',
        'node_modules', '.svn', '.vs', 'bin', 'obj', '.idea', '.vscode'
    ),

    # 目錄數超過此值就中止，不推送。
    # 防呆：根路徑設錯（例如指到整個原始碼目錄）時，會把數萬筆無關目錄
    # 推成手機的上傳選單，且掃描本身就要跑很久。
    [int] $MaxDirs = 50000,

    # 掃描過程每隔這麼多秒回報一次進度。
    # 用時間而非目錄數當間隔：目錄數多寡差異太大，固定筆數可能幾秒洗一行，
    # 也可能十幾分鐘不吭聲，讓人分不清是在跑還是卡死。
    [int] $ProgressSeconds = 15,

    # ⚠️ 以下路徑參數的預設值不可寫成 (Join-Path $PSScriptRoot ...)。
    #    在 [CmdletBinding()] 的 param 區塊裡，$PSScriptRoot 求值時是空字串，
    #    Join-Path 會直接拋「Cannot bind argument to parameter 'Path'」而中止，
    #    連 log 都寫不出來（實測：不傳該參數時必炸）。
    #    因此一律留空，改在下方 body 內補上預設值——那裡 $PSScriptRoot 才有值。
    [string] $LogFile,

    # 上一輪的掃描結果快照，用來比對本輪有沒有變動（決定要不要寄通知信）。
    # 存的是目錄清單與標記檔位置，不含照片內容，檔案很小。
    [string] $SnapshotFile,

    # 加上這個參數就不寄信（排查問題時避免洗版收件匣）
    [switch] $NoMail,

    # 失敗告警的抑制記錄：記下上次為哪個錯誤寄過信、何時寄的
    [string] $AlertStateFile,

    # 同一個錯誤在這麼多小時內只告警一次。
    # 排程 10 分鐘一輪，斷線這類問題會持續數天，每輪都寄等於一天 144 封。
    [int] $AlertQuietHours = 6,

    # 每日彙總（一天一列，可直接用 Excel 開）
    [string] $SummaryFile,

    # 設定檔路徑（預設同目錄的 config.json）
    [string] $ConfigPath
)

# 補上路徑類參數的預設值（見上方 param 區塊的說明：那裡不能用 $PSScriptRoot）
if (-not $LogFile)        { $LogFile        = Join-Path $PSScriptRoot 'logs\push-tree.log' }
if (-not $SnapshotFile)   { $SnapshotFile   = Join-Path $PSScriptRoot 'logs\tree-snapshot.json' }
if (-not $AlertStateFile) { $AlertStateFile = Join-Path $PSScriptRoot 'logs\last-alert.json' }
if (-not $SummaryFile)    { $SummaryFile    = Join-Path $PSScriptRoot 'logs\daily-push-tree.csv' }
if (-not $ConfigPath)     { $ConfigPath     = Join-Path $PSScriptRoot 'config.json' }

. (Join-Path $PSScriptRoot 'Common.ps1')

# 防止排程重疊：目錄很多時掃描可能跑超過排程間隔，
# 兩份同時跑會用各自的掃描結果互相覆寫 TREE（updateTree 是覆寫語意）。
$lock = Get-SnapSyncLock -Name 'SnapSync-PushTree' -LogFile $LogFile
if (-not $lock) {
    Write-Log -Message '上一輪尚未結束，本輪跳過（正常現象，不需處理）' -LogFile $LogFile
    try {
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Skipped = 1; Failed = 0 } `
            -Notes '上一輪未結束，本輪跳過'
    } catch { }
    exit 0
}

try {
    $cfg = Get-SnapSyncConfig -ConfigPath $ConfigPath
    $items = New-Object System.Collections.Generic.List[object]

    # 已加入的相對路徑，避免同一個目錄重複列入。
    # 重複來源：標記目錄的祖先鏈（見下方 Add-Node）可能被多個標記目錄共用，
    # 例如 A/B/C 與 A/B/D 都標記時，A 和 A/B 會各被補兩次。
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    # 至少有一個根掃成功才允許推送——否則 updateTree 的覆寫語意
    # 會把整棵 TREE 清成空的，手機端就完全選不到目錄了。
    $okRoots = 0
    $failedRoots = @()

    # 全部根的標記檔位置，寄通知信時列出
    $allMarkers = New-Object System.Collections.Generic.List[string]

    foreach ($rootName in $cfg.Roots.Keys) {
        $rootFull = $cfg.Roots[$rootName]
        $label = if ($rootName) { $rootName } else { '<預設>' }
        Write-Log -Message "開始掃描：$label → $rootFull（標記檔：$MarkerName）" -LogFile $LogFile

        $prefixLen = $rootFull.Length + 1

        # 這個根本輪掃出來的節點，先收在暫存區。
        # 掃到一半失敗時整個丟棄，不讓半棵殘缺的樹混進 $items——
        # 殘缺的樹推上去，手機選單會少掉一半目錄，比整根跳過更難察覺。
        $pending = New-Object System.Collections.Generic.List[object]
        $pendingSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

        # 把一個相對路徑（含其所有祖先）加進暫存區。
        # 必須補祖先：手機 PWA 是靠 path 的層級關係展開選單的，
        # 只推 A/B/C 而沒有 A 和 A/B，這個節點在選單上永遠展不開。
        $addNode = {
            param([string] $RelPath)

            $segs = $RelPath -split '/'
            for ($i = 1; $i -le $segs.Count; $i++) {
                $sub = ($segs[0..($i - 1)]) -join '/'
                if ($pendingSeen.Add($sub)) {
                    $pending.Add(@{
                        path = $(if ($rootName) { "$rootName/$sub" } else { $sub })
                        name = $segs[$i - 1]
                    }) | Out-Null
                }
            }
        }

        $scanned = 0
        $markers = 0
        # 標記檔位置清單，寄通知信時要一併列出，讓維護人員知道現在開通了哪些點
        $markerPaths = New-Object System.Collections.Generic.List[string]
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $rootOk = $false
        $lastErr = $null

        for ($attempt = 1; $attempt -le $RootRetry -and -not $rootOk; $attempt++) {
            if ($attempt -gt 1) {
                Write-Log -Message ("  第 {0} 次重試（前次失敗：{1}）" -f $attempt, $lastErr) `
                    -Level 'WARN' -LogFile $LogFile
                Start-Sleep -Seconds (5 * ($attempt - 1))
            }

            # 網路磁碟機在兩次嘗試之間可能已經斷了，重試前重新確認
            if (-not (Test-Path -LiteralPath $rootFull)) {
                $lastErr = "根目錄不存在或無法存取：$rootFull"
                continue
            }

            $pending.Clear()
            $pendingSeen.Clear()
            $markerPaths.Clear()
            $scanned = 0
            $markers = 0
            $sw.Restart()

            try {
                # 自行以堆疊遞迴，而不是用 Get-ChildItem -Recurse -Filter。
                #
                # 原因是進度回報：-Filter 只會把「找到的標記檔」送進管線，
                # 中間掃過的幾千個目錄完全不經過這裡，於是標記很少（甚至沒有）時
                # log 會一整段時間毫無輸出，看起來就像當掉——實測掃 Z: 時
                # 「掃描中…」之後 20 分鐘不吭聲，無法判斷是在跑還是卡死。
                #
                # 自己走的話每進一個目錄都能計數，才有辦法按時間回報進度。
                Write-Log -Message "  掃描中…（不限深度，目錄很多時需要一些時間）" -LogFile $LogFile

                $stack = New-Object System.Collections.Generic.Stack[string]
                $stack.Push($rootFull)

                # 依「時間」而非「數量」回報：目錄數不確定，用固定筆數當間隔
                # 可能幾秒就洗一行、也可能十分鐘不出聲，時間間隔才穩定。
                $nextReport = $ProgressSeconds

                while ($stack.Count -gt 0) {
                    $cur = $stack.Pop()

                    # 列出這一層的子目錄。權限不足等單點錯誤在此吞掉繼續走；
                    # 整個磁碟機斷線會是終止錯誤，由外層 catch 接住重試。
                    $children = @(Get-ChildItem -LiteralPath $cur -Directory -Force -ErrorAction SilentlyContinue)

                    foreach ($d in $children) {
                        $scanned++

                        if ($sw.Elapsed.TotalSeconds -ge $nextReport) {
                            $nextReport += $ProgressSeconds
                            # 附上目前所在目錄，卡住時看得出卡在哪一支
                            $where = $d.FullName
                            if ($where.Length -gt 70) { $where = '…' + $where.Substring($where.Length - 69) }
                            Write-Log -Message ("  已掃 {0} 個目錄、找到 {1} 個標記、納入 {2} 個（{3} 秒）｜{4}" -f `
                                $scanned, $markers, $pending.Count,
                                [math]::Round($sw.Elapsed.TotalSeconds, 1), $where) -LogFile $LogFile
                        }

                        $relPath = $d.FullName.Substring($prefixLen) -replace '\\', '/'
                        $parts = $relPath -split '/'

                        # 排除名單裡的目錄整支不進去（node_modules 之類動輒上萬個子目錄）
                        if ($ExcludeNames -contains $d.Name) { continue }

                        if ($MaxDepth -gt 0 -and $parts.Count -ge $MaxDepth) {
                            # 已達深度上限，不再往下探
                        }
                        else {
                            $stack.Push($d.FullName) | Out-Null
                        }

                        # 這個目錄有標記 → 它與底下所有子目錄都納入
                        if (Test-Path -LiteralPath (Join-Path $d.FullName $MarkerName)) {
                            $markers++
                            $markerPaths.Add($(if ($rootName) { "$rootName/$relPath" } else { $relPath })) | Out-Null
                            Write-Log -Message ("    找到標記：{0}" -f $relPath) -LogFile $LogFile

                            & $addNode $relPath

                            Get-ChildItem -LiteralPath $d.FullName -Recurse -Directory -Force `
                                -ErrorAction SilentlyContinue |
                                ForEach-Object {
                                $subRel = $_.FullName.Substring($prefixLen) -replace '\\', '/'
                                $subParts = $subRel -split '/'

                                if ($MaxDepth -gt 0 -and $subParts.Count -gt $MaxDepth) { return }

                                $subSkip = $false
                                foreach ($p in $subParts) {
                                    if ($ExcludeNames -contains $p) { $subSkip = $true; break }
                                }
                                if ($subSkip) { return }

                                & $addNode $subRel
                            }
                        }

                        if ($pending.Count -ge $MaxDirs) {
                            throw ("目錄數超過上限 $MaxDirs。請確認標記檔（$MarkerName）沒有放在" +
                                   "太上層的目錄；若確實需要這麼多目錄，請加大 -MaxDirs。")
                        }
                    }
                }

                $rootOk = $true
            }
            catch {
                $lastErr = $_.Exception.Message
            }
        }

        $sw.Stop()

        if (-not $rootOk) {
            # 單根失敗不中斷其他根：桃園（網路磁碟機）斷線時，
            # 台北的目錄樹沒理由跟著一起不能更新。
            Write-Log -Message ("  {0}：掃描失敗，已重試 {1} 次仍不成功（{2}），本輪跳過此根" -f `
                $label, $RootRetry, $lastErr) -Level 'ERROR' -LogFile $LogFile
            $failedRoots += $label
            continue
        }

        # 多根模式下，根名稱本身也要成為目錄樹的一層（第一層節點）。
        # 放在這裡而非迴圈開頭：掃描失敗的根不該只留一個空殼節點在選單上。
        if ($rootName -and $seen.Add($rootName)) {
            $items.Add(@{ path = $rootName; name = $rootName }) | Out-Null
        }

        foreach ($node in $pending) {
            if ($seen.Add([string]$node.path)) { $items.Add($node) | Out-Null }
        }
        foreach ($mp in $markerPaths) { $allMarkers.Add($mp) | Out-Null }

        $okRoots++
        Write-Log -Message ("  {0}：找到 {1} 個標記、納入 {2} 個目錄（{3} 秒）" -f `
            $label, $markers, $pending.Count, [math]::Round($sw.Elapsed.TotalSeconds, 1)) -LogFile $LogFile

        if ($markers -eq 0) {
            Write-Log -Message ("  {0}：沒有找到任何 {1} 標記檔，此根不會出現在手機選單" -f $label, $MarkerName) `
                -Level 'WARN' -LogFile $LogFile
        }
    }

    # 全部的根都掃失敗時絕不推送：推空的 TREE 等於清掉手機端所有選項
    if ($okRoots -eq 0) {
        throw ("所有根目錄都掃描失敗（{0}），不推送以免清空 TREE" -f ($failedRoots -join '、'))
    }

    Write-Log -Message "合計 $($items.Count) 個目錄，開始推送" -LogFile $LogFile

    if ($failedRoots.Count -gt 0) {
        # 講清楚後果：updateTree 是覆寫語意，這次沒掃到的根，
        # 在手機選單上會直接消失，直到下一輪掃成功才回來。
        Write-Log -Message ("注意：{0} 掃描失敗未納入，這些根的目錄本輪會從手機選單上消失" -f `
            ($failedRoots -join '、')) -Level 'WARN' -LogFile $LogFile
    }

    # updateTree 是覆寫語意，一次推太多代表標記檔放得太上層
    if ($items.Count -gt 500) {
        Write-Log -Message ("目錄數 {0} 偏多，手機選單會難以操作，請確認 $MarkerName 沒有放在太上層的目錄" -f $items.Count) `
            -Level 'WARN' -LogFile $LogFile
    }

    if ($items.Count -eq 0) {
        Write-Log -Message ("沒有可推送的目錄，結束（不覆寫 TREE 以免清空既有資料）。" +
            "若這不是預期結果，請確認要出現在手機選單的目錄裡有放 $MarkerName 檔案。") `
            -Level 'WARN' -LogFile $LogFile
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Skipped = 1; Failed = 0 } `
            -Notes ("掃描結果為空（找不到任何 {0} 標記），未推送" -f $MarkerName)
        exit 0
    }

    $resp = Invoke-SnapSyncApi -Endpoint $cfg.Endpoint -Method 'POST' -Payload @{
        action = 'updateTree'
        token  = $cfg.AdminToken
        tree   = $items.ToArray()
    }

    Write-Log -Message "推送完成：TREE 已更新 $($resp.count) 列（updatedAt=$($resp.updatedAt)）" -LogFile $LogFile

    # ---- 與上一輪比對，有變動才寄通知信 ----
    # 只在推送成功後才做：推失敗時 TREE 沒更新，寄「已變動」會誤導。
    # 整段包在 try 裡——通知信失敗絕不能影響已經成功的推送結果。
    try {
        $curPaths = @($items | ForEach-Object { [string]$_.path })
        $curMarkers = @($allMarkers)

        $prev = Get-TreeSnapshot -Path $SnapshotFile
        $isFirstRun = ($null -eq $prev)

        if ($isFirstRun) {
            # 第一次執行沒有比較基準，全部都算「新增」會寄出整棵樹，
            # 對維護人員沒有意義。只建立基準，不寄信。
            Write-Log -Message '首次建立目錄樹快照，本輪不寄通知信（下一輪起才比對變動）' -LogFile $LogFile
        }
        else {
            $diff = Compare-TreeSnapshot -Before @($prev.paths) -After $curPaths
            $mdiff = Compare-TreeSnapshot -Before @($prev.markers) -After $curMarkers

            if (-not $diff.HasChange -and -not $mdiff.HasChange) {
                Write-Log -Message '目錄樹與上一輪相同，不寄通知信' -LogFile $LogFile
            }
            elseif ($NoMail) {
                Write-Log -Message ("目錄樹有變動（新增 {0}、消失 {1}），但指定了 -NoMail，不寄信" -f `
                    $diff.Added.Count, $diff.Removed.Count) -LogFile $LogFile
            }
            elseif (-not $cfg.Mail) {
                Write-Log -Message ("目錄樹有變動（新增 {0}、消失 {1}），但 config.json 未設定 Mail，不寄信" -f `
                    $diff.Added.Count, $diff.Removed.Count) -Level 'WARN' -LogFile $LogFile
            }
            else {
                Write-Log -Message ("目錄樹有變動：新增 {0} 個、消失 {1} 個，準備寄通知信" -f `
                    $diff.Added.Count, $diff.Removed.Count) -LogFile $LogFile

                $sb = New-Object Text.StringBuilder
                [void]$sb.AppendLine("目錄樹已更新（$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')）")
                [void]$sb.AppendLine()
                [void]$sb.AppendLine("共 $($resp.count) 個目錄，$okRoots/$($cfg.Roots.Count) 個根掃描成功。")
                if ($failedRoots.Count -gt 0) {
                    [void]$sb.AppendLine("⚠️ 掃描失敗的根：$($failedRoots -join '、')")
                    [void]$sb.AppendLine("   這些根的目錄本輪不在手機選單上，直到下一輪掃成功才會回來。")
                }
                [void]$sb.AppendLine()

                [void]$sb.AppendLine('===== 變動摘要 =====')
                if ($diff.Added.Count -gt 0) {
                    [void]$sb.AppendLine("新增 $($diff.Added.Count) 個目錄：")
                    foreach ($x in $diff.Added) { [void]$sb.AppendLine("  [+] $x") }
                    [void]$sb.AppendLine()
                }
                if ($diff.Removed.Count -gt 0) {
                    [void]$sb.AppendLine("消失 $($diff.Removed.Count) 個目錄：")
                    foreach ($x in $diff.Removed) { [void]$sb.AppendLine("  [-] $x") }
                    [void]$sb.AppendLine("  （目錄被移走或改名，也可能是 $MarkerName 標記檔被刪除）")
                    [void]$sb.AppendLine()
                }

                [void]$sb.AppendLine("===== 標記檔（$MarkerName）位置 =====")
                [void]$sb.AppendLine("共 $($curMarkers.Count) 個。只有放了標記檔的目錄（含其子目錄）會出現在手機選單。")
                if ($mdiff.HasChange) {
                    foreach ($x in $mdiff.Added)   { [void]$sb.AppendLine("  [+] $x") }
                    foreach ($x in $mdiff.Removed) { [void]$sb.AppendLine("  [-] $x") }
                }
                foreach ($x in ($curMarkers | Sort-Object)) {
                    if ($mdiff.Added -contains $x) { continue }   # 上面已列過
                    [void]$sb.AppendLine("      $x")
                }
                [void]$sb.AppendLine()

                [void]$sb.AppendLine('===== 完整目錄樹 =====')
                [void]$sb.AppendLine('（[+] 本輪新增、[-] 本輪消失）')
                [void]$sb.AppendLine()
                [void]$sb.AppendLine((Format-TreeText -Paths $curPaths -Added $diff.Added -Removed $diff.Removed))

                $subject = "[SnapSync] 目錄樹變動：新增 $($diff.Added.Count)、消失 $($diff.Removed.Count)"
                Send-TreeChangeMail -MailConfig $cfg.Mail -Subject $subject `
                    -Body $sb.ToString() -LogFile $LogFile | Out-Null
            }
        }

        # 不論有沒有寄信都要更新快照，否則下一輪會重複偵測到同一批變動
        Save-TreeSnapshot -Path $SnapshotFile -Paths $curPaths -Markers $curMarkers
    }
    catch {
        # 通知信是附加功能，出錯不影響「目錄樹已推送成功」這個事實
        Write-Log -Message ("變動比對／通知信處理失敗（不影響推送結果）：{0}" -f $_.Exception.Message) `
            -Level 'WARN' -LogFile $LogFile
    }

    $note = "最後推送 {0} 個目錄（{1}/{2} 個根成功）" -f $resp.count, $okRoots, $cfg.Roots.Count
    if ($failedRoots.Count -gt 0) { $note += "；失敗：$($failedRoots -join '、')" }

    Add-DailySummary -SummaryFile $SummaryFile `
        -Stats @{ Runs = 1; Skipped = 0; Failed = $failedRoots.Count } `
        -Notes $note
    exit 0
}
catch {
    $errMsg = $_.Exception.Message
    Write-Log -Message "執行失敗：$errMsg" -Level 'ERROR' -LogFile $LogFile
    Write-Log -Message $_.ScriptStackTrace -Level 'ERROR' -LogFile $LogFile

    # 失敗也要進彙總，否則「今天沒推成功」在報表上看不出來
    try {
        Add-DailySummary -SummaryFile $SummaryFile `
            -Stats @{ Runs = 1; Skipped = 0; Failed = 1 } `
            -Notes ("失敗：{0}" -f $errMsg)
    } catch { }

    # ---- 失敗告警信 ----
    # ⚠️ 必須抑制重複：排程 10 分鐘一輪，網路磁碟機斷線這種問題會持續好幾天，
    #    每輪都寄等於一天灌 144 封信，收件匣爆掉之後真正重要的信也會被忽略。
    #    因此同一個錯誤在 $AlertQuietHours 小時內只寄一次。
    try {
        if (-not $NoMail) {
            $mailCfg = $null
            try { $mailCfg = (Get-SnapSyncConfig -ConfigPath $ConfigPath).Mail } catch { }

            if ($mailCfg) {
                # 以「錯誤訊息 + 上次寄送時間」判斷要不要再寄
                $lastAlert = $null
                if (Test-Path -LiteralPath $AlertStateFile) {
                    try { $lastAlert = Get-Content -LiteralPath $AlertStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
                }

                $sameErr = $lastAlert -and ([string]$lastAlert.message -eq $errMsg)
                $withinQuiet = $false
                if ($sameErr -and $lastAlert.sentAt) {
                    try {
                        $withinQuiet = ((Get-Date) - [datetime]$lastAlert.sentAt).TotalHours -lt $AlertQuietHours
                    } catch { }
                }

                if ($withinQuiet) {
                    Write-Log -Message ("相同錯誤已於 {0} 告警過，{1} 小時內不重複寄信" -f `
                        $lastAlert.sentAt, $AlertQuietHours) -LogFile $LogFile
                }
                else {
                    $ab = New-Object Text.StringBuilder
                    [void]$ab.AppendLine("Push-Tree 執行失敗（$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')）")
                    [void]$ab.AppendLine()
                    [void]$ab.AppendLine('錯誤訊息：')
                    [void]$ab.AppendLine("  $errMsg")
                    [void]$ab.AppendLine()
                    [void]$ab.AppendLine("執行主機：$env:COMPUTERNAME")
                    [void]$ab.AppendLine("執行身分：$env:USERDOMAIN\$env:USERNAME")
                    [void]$ab.AppendLine("腳本路徑：$PSCommandPath")
                    [void]$ab.AppendLine("記錄檔　：$LogFile")
                    [void]$ab.AppendLine()
                    [void]$ab.AppendLine('影響：')
                    [void]$ab.AppendLine('  本輪未推送目錄樹，手機選單維持上一次成功的內容。')
                    [void]$ab.AppendLine('  照片上傳不受影響，但新建立的目錄不會出現在選單上。')
                    [void]$ab.AppendLine()
                    [void]$ab.AppendLine('堆疊追蹤：')
                    [void]$ab.AppendLine($_.ScriptStackTrace)
                    [void]$ab.AppendLine()
                    [void]$ab.AppendLine("※ 相同錯誤在 $AlertQuietHours 小時內不會重複寄信，排除後即恢復正常通知。")

                    $sent = Send-TreeChangeMail -MailConfig $mailCfg `
                        -Subject "[SnapSync] ⚠️ Push-Tree 執行失敗：$errMsg" `
                        -Body $ab.ToString() -LogFile $LogFile

                    if ($sent) {
                        $dir = Split-Path -Parent $AlertStateFile
                        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
                            New-Item -ItemType Directory -Force -Path $dir | Out-Null
                        }
                        $state = [ordered]@{ message = $errMsg; sentAt = (Get-Date).ToString('o') }
                        [IO.File]::WriteAllText($AlertStateFile,
                            ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
                    }
                }
            }
        }
    } catch {
        # 告警信本身失敗不能再拋例外，否則會蓋掉原始錯誤
        Write-Log -Message ("告警信寄送失敗：{0}" -f $_.Exception.Message) -Level 'WARN' -LogFile $LogFile
    }

    exit 1
}
finally {
    Release-SnapSyncLock -Lock $lock
}
