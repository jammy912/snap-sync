# =====================================================================
# Common.ps1 — 共用設定與函式（由 Push-Tree.ps1 / Sync-Queue.ps1 載入）
#
# 【設定方式】
#   把設定放在同目錄的 config.json（已列入 .gitignore），格式：
#     {
#       "Endpoint":   "https://script.google.com/macros/s/xxx/exec",
#       "AdminToken": "內部強token",
#       "Roots": {
#         "工程": "D:\\工程專案",
#         "驗收": "E:\\驗收照片"
#       }
#     }
#
#   Roots 是「根名稱 → 實體路徑」的對應表，支援多個本機路徑。
#   根名稱會成為目錄樹的第一層，手機上看到的路徑形如「工程/專案A/區域1」，
#   落地時再由根名稱查回實體路徑：D:\工程專案\專案A\區域1\<檔名>。
#   USERS 的 rootPath 可設為「工程」限制某人只看得到該根，或設「工程/專案A」
#   限制到更細的子樹。
#
#   單一路徑時仍可用舊格式 "RootDir": "D:\\工程專案"，
#   會自動轉為 { "": "D:\\工程專案" }（不加根名稱前綴，行為與先前一致）。
#
# 【編碼提醒】
#   本檔含中文，必須存成 UTF-8 with BOM。PowerShell 5.1 沒看到 BOM
#   會用 ANSI 誤讀中文而爆 ParserError。
# =====================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PowerShell 5.1 預設 TLS 可能不含 1.2，呼叫 Google 端點會失敗
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-SnapSyncConfig {
    [CmdletBinding()]
    param(
        [string] $ConfigPath = (Join-Path $PSScriptRoot 'config.json')
    )

    $endpoint = $env:SNAPSYNC_ENDPOINT
    $adminToken = $env:SNAPSYNC_TOKEN
    $roots = [ordered]@{}
    $mail = $null

    # 環境變數只支援單一路徑（多路徑請用 config.json）
    if ($env:SNAPSYNC_ROOT) { $roots[''] = $env:SNAPSYNC_ROOT }

    if (Test-Path -LiteralPath $ConfigPath) {
        $json = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $names = $json.PSObject.Properties.Name

        if ($names -contains 'Endpoint' -and $json.Endpoint) { $endpoint = $json.Endpoint }
        if ($names -contains 'AdminToken' -and $json.AdminToken) { $adminToken = $json.AdminToken }

        if ($names -contains 'Roots' -and $json.Roots) {
            $roots = [ordered]@{}
            foreach ($p in $json.Roots.PSObject.Properties) {
                $roots[$p.Name] = $p.Value
            }
        }
        elseif ($names -contains 'RootDir' -and $json.RootDir) {
            # 舊格式相容：單一路徑、不加根名稱前綴
            $roots = [ordered]@{ '' = $json.RootDir }
        }

        # 郵件設定是選用的：沒設就不寄通知信，不影響目錄樹推送
        if ($names -contains 'Mail' -and $json.Mail) { $mail = $json.Mail }
    }

    if (-not $endpoint) {
        throw "設定缺少 Endpoint。請在 $ConfigPath 設定，或設定環境變數 SNAPSYNC_ENDPOINT。"
    }
    if (-not $adminToken) {
        throw "設定缺少 AdminToken。請在 $ConfigPath 設定，或設定環境變數 SNAPSYNC_TOKEN。"
    }
    if ($roots.Count -eq 0) {
        throw "設定缺少 Roots（或 RootDir）。請在 $ConfigPath 設定至少一個本機路徑。"
    }

    # 逐一驗證實體路徑存在，並正規化為絕對路徑
    $resolved = [ordered]@{}
    foreach ($name in $roots.Keys) {
        $dir = $roots[$name]
        if (-not (Test-Path -LiteralPath $dir)) {
            throw "來源/落地目錄不存在：$dir（根名稱：$(if ($name) { $name } else { '<預設>' })）"
        }
        # 根名稱不可含路徑分隔符，否則會破壞第一層對應關係
        if ($name -match '[\\/]') {
            throw "根名稱不可包含斜線：$name"
        }
        # ⚠️ 必須用 .ProviderPath 而非 .Path。
        # UNC 路徑經 Resolve-Path 後，.Path 會帶上 PowerShell 的 provider 前綴：
        #   .Path         = Microsoft.PowerShell.Core\FileSystem::\\host\share\dir
        #   .ProviderPath = \\host\share\dir
        # Get-ChildItem 兩種都吃得下，但子項目的 FullName 一律是無前綴的真實路徑，
        # 拿帶前綴的長度去 Substring 算相對路徑會直接越界，掃描在第一個目錄就中斷
        # （實測症狀：UNC 根「0 秒掃完、納入 0 個目錄」）。
        $resolved[$name] = (Resolve-Path -LiteralPath $dir).ProviderPath.TrimEnd('\')
    }

    return [pscustomobject]@{
        Endpoint   = $endpoint
        AdminToken = $adminToken
        Roots      = $resolved
        Mail       = $mail
    }
}

<#
.SYNOPSIS
  把伺服器來的相對路徑（含根名稱）解析為本機實體路徑。

.DESCRIPTION
  targetPath 形如「工程/專案A/區域1」時，第一段「工程」是根名稱，
  查 Roots 對應表得到 D:\工程專案，再接上其餘段落。

  單根模式（根名稱為空字串）時不剝除第一段，直接接在該路徑後。

  回傳 $null 表示根名稱查不到——呼叫端必須視為失敗、不可落地。
#>
function Resolve-LocalPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $TargetPath,
        [Parameter(Mandatory)] $Roots
    )

    $clean = $TargetPath -replace '/', '\'
    $clean = $clean.Trim('\')

    # 單根模式：Roots 只有一個且名稱為空
    if ($Roots.Count -eq 1 -and $Roots.Keys -contains '') {
        return [pscustomobject]@{
            RootDir = $Roots['']
            SubPath = $clean
        }
    }

    $parts = $clean -split '\\', 2
    $rootName = $parts[0]
    $sub = if ($parts.Count -gt 1) { $parts[1] } else { '' }

    if (-not ($Roots.Keys -contains $rootName)) {
        return $null
    }

    return [pscustomobject]@{
        RootDir = $Roots[$rootName]
        SubPath = $sub
    }
}

function Write-Log {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string] $Level = 'INFO',
        [string] $LogFile
    )
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Output $line
    if ($LogFile) {
        $dir = Split-Path -Parent $LogFile
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    }
}

# =====================================================================
# 單一執行個體鎖（防止排程重疊執行）
#
# 排程間隔縮短（例如 5 分鐘）時，上一輪可能還沒跑完下一輪就啟動。
# 重疊執行的後果：
#   Sync-Queue  兩個 process 抓到同一批 QUEUE 項目，同時寫入相同檔名，
#               互相覆寫到一半的 .part 檔，甚至一邊還在下載一邊被另一邊 ack。
#   Push-Tree   兩份掃描結果互相覆寫 TREE，短暫出現不完整的目錄樹。
#
# 用具名 Mutex 而非 lock 檔：process 被強制結束（工作排程器逾時、當機）時
# 作業系統會自動釋放 Mutex，不會留下永久卡住的殘留鎖檔。
# =====================================================================

<#
.SYNOPSIS
  取得單一執行個體鎖；若同名作業已在執行則回傳 $null。

.PARAMETER Name
  作業名稱，同名才會互斥。例如 'SnapSync-SyncQueue'。

.EXAMPLE
  $lock = Get-SnapSyncLock -Name 'SnapSync-SyncQueue' -LogFile $LogFile
  if (-not $lock) { exit 0 }
  try { ... } finally { Release-SnapSyncLock -Lock $lock }
#>
function Get-SnapSyncLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Name,
        [string] $LogFile
    )

    # Global\ 前綴讓不同登入工作階段（互動登入 vs 排程服務）也能互斥，
    # 否則你手動執行時擋不住背景排程那一份。
    $mutex = New-Object Threading.Mutex($false, "Global\$Name")

    try {
        # 逾時 0 = 拿不到就立刻放棄，不排隊等待。
        # 排隊沒有意義：下一輪 5 分鐘後本來就會再跑。
        $acquired = $mutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
        # 前一個持有者沒正常釋放就結束（當機／被 kill）。
        # 這種情況下鎖仍算取得成功，但值得記錄——可能代表上一輪異常中止。
        Write-Log -Message '偵測到前一輪未正常結束（鎖被遺棄），本輪繼續執行' `
            -Level 'WARN' -LogFile $LogFile
        $acquired = $true
    }

    if (-not $acquired) {
        $mutex.Dispose()
        return $null
    }
    return $mutex
}

<#
.SYNOPSIS
  釋放 Get-SnapSyncLock 取得的鎖。務必放在 finally 區塊。
#>
function Release-SnapSyncLock {
    [CmdletBinding()]
    param([Threading.Mutex] $Lock)

    if (-not $Lock) { return }
    try { $Lock.ReleaseMutex() } catch { }
    $Lock.Dispose()
}

# =====================================================================
# 每日彙總記錄
#
# 每輪排程執行完都累加當日統計，寫成一行一天的 daily-*.csv，
# 讓「今天到底做了什麼」一眼可查，不必翻整天的逐行 log。
#
# 用 CSV 是為了能直接丟進 Excel 看趨勢；每次執行都重寫當日那一列
# （以日期為鍵），所以檔案是「一天一列」而非每輪一列。
# =====================================================================

<#
.SYNOPSIS
  累加當日統計並重寫每日彙總 CSV。

.PARAMETER Stats
  雜湊表，欄位視作業而定。例如：
    @{ Runs=1; Ok=5; Fail=0; Bytes=1234567 }
  同名欄位會與當日既有值相加。

.PARAMETER Notes
  當日最後一次執行的備註（例如錯誤摘要），直接覆寫不累加。
#>
function Add-DailySummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $SummaryFile,
        [Parameter(Mandatory)][hashtable] $Stats,
        [string] $Notes = ''
    )

    $today = Get-Date -Format 'yyyy-MM-dd'
    $dir = Split-Path -Parent $SummaryFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    $rows = @()
    if (Test-Path -LiteralPath $SummaryFile) {
        $rows = @(Import-Csv -LiteralPath $SummaryFile -Encoding UTF8)
    }

    $todayRow = $rows | Where-Object { $_.Date -eq $today } | Select-Object -First 1

    if ($null -eq $todayRow) {
        $props = [ordered]@{ Date = $today }
        foreach ($k in $Stats.Keys) { $props[$k] = [string]$Stats[$k] }
        $props['LastRun'] = (Get-Date -Format 'HH:mm:ss')
        $props['Notes'] = $Notes
        $rows += [pscustomobject]$props
    }
    else {
        foreach ($k in $Stats.Keys) {
            $old = 0
            if ($todayRow.PSObject.Properties.Name -contains $k) {
                [void][int]::TryParse([string]$todayRow.$k, [ref]$old)
            }
            $new = $old + [int]$Stats[$k]
            if ($todayRow.PSObject.Properties.Name -contains $k) { $todayRow.$k = [string]$new }
            else { $todayRow | Add-Member -NotePropertyName $k -NotePropertyValue ([string]$new) }
        }
        $todayRow.LastRun = (Get-Date -Format 'HH:mm:ss')
        $todayRow.Notes = $Notes
    }

    # 只保留最近 400 天，避免無限成長
    $rows = $rows | Sort-Object Date | Select-Object -Last 400
    $rows | Export-Csv -LiteralPath $SummaryFile -NoTypeInformation -Encoding UTF8
}

# =====================================================================
# 目錄樹變動通知
#
# Push-Tree 每輪都會重掃並覆寫 TREE，但維護人員無從得知「今天多了哪個
# 現場、哪個目錄被移走了」。這裡把每輪結果存成快照，與上一輪比對，
# 有變動才寄信——排程 10 分鐘一輪，沒變動也寄會變成沒人看的騷擾信。
# =====================================================================

<#
.SYNOPSIS
  讀取上一輪的快照；不存在或損毀時回傳 $null（視為「沒有前一輪」）。
#>
function Get-TreeSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if (-not $raw) { return $null }
        return $raw | ConvertFrom-Json
    }
    catch {
        # 快照損毀不該中斷主流程：當成沒有前一輪，本輪重新建立
        return $null
    }
}

<#
.SYNOPSIS
  寫入本輪快照，供下一輪比對。

.PARAMETER Paths
  本輪納入 TREE 的所有相對路徑。

.PARAMETER Markers
  本輪找到的標記檔位置。
#>
function Save-TreeSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Path,
        [string[]] $Paths = @(),
        [string[]] $Markers = @()
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    $obj = [ordered]@{
        updatedAt = (Get-Date).ToString('o')
        paths     = @($Paths | Sort-Object)
        markers   = @($Markers | Sort-Object)
    }
    # 用 WriteAllText 而非 Out-File：確保是不帶 BOM 的 UTF-8，
    # ConvertFrom-Json 讀回時才不會在開頭吃到 BOM 字元而解析失敗。
    [IO.File]::WriteAllText($Path, ($obj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
}

<#
.SYNOPSIS
  比對前後兩輪的路徑清單，回傳新增與消失的項目。

.OUTPUTS
  PSCustomObject：Added / Removed / HasChange
#>
function Compare-TreeSnapshot {
    [CmdletBinding()]
    param(
        [string[]] $Before = @(),
        [string[]] $After = @()
    )

    $b = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($x in $Before) { if ($x) { $b.Add($x) | Out-Null } }
    $a = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($x in $After) { if ($x) { $a.Add($x) | Out-Null } }

    $added = @($After | Where-Object { $_ -and -not $b.Contains($_) } | Sort-Object)
    $removed = @($Before | Where-Object { $_ -and -not $a.Contains($_) } | Sort-Object)

    return [pscustomobject]@{
        Added     = $added
        Removed   = $removed
        HasChange = (($added.Count + $removed.Count) -gt 0)
    }
}

<#
.SYNOPSIS
  把扁平的路徑清單畫成樹狀圖，變動處以標記標示。

.DESCRIPTION
  用 ├─ └─ │ 畫出層級。新增的目錄標 [+]、消失的標 [-]。
  消失的目錄不在 Paths 裡（本輪已經沒有了），所以要另外併進來，
  否則維護人員看不到「什麼不見了」——那往往才是需要追查的事。

.PARAMETER Paths
  本輪的完整路徑清單（相對路徑，以 / 分隔）。
#>
function Format-TreeText {
    [CmdletBinding()]
    param(
        [string[]] $Paths = @(),
        [string[]] $Added = @(),
        [string[]] $Removed = @()
    )

    $addedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($x in $Added) { if ($x) { $addedSet.Add($x) | Out-Null } }
    $removedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($x in $Removed) { if ($x) { $removedSet.Add($x) | Out-Null } }

    # 消失的目錄要一起畫出來（標 [-]），否則信裡看不到少了什麼
    $all = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $Paths) { if ($p) { $all.Add($p) | Out-Null } }
    foreach ($p in $Removed) {
        if (-not $p) { continue }
        # 連同其祖先一併補進來，否則畫樹時會缺層而掛在錯誤的位置
        $segs = $p -split '/'
        for ($i = 1; $i -le $segs.Count; $i++) {
            $all.Add((($segs[0..($i - 1)]) -join '/')) | Out-Null
        }
    }

    # 依父路徑分組，才能逐層遞迴輸出
    $childrenOf = @{}
    foreach ($p in $all) {
        $segs = $p -split '/'
        $parent = if ($segs.Count -gt 1) { ($segs[0..($segs.Count - 2)]) -join '/' } else { '' }
        if (-not $childrenOf.ContainsKey($parent)) {
            $childrenOf[$parent] = New-Object System.Collections.Generic.List[string]
        }
        $childrenOf[$parent].Add($p) | Out-Null
    }

    $lines = New-Object System.Collections.Generic.List[string]

    # 以堆疊模擬遞迴：PowerShell 的巢狀函式在此不好傳遞閉包變數，
    # 而且目錄深時遞迴呼叫的成本也高。堆疊元素為 路徑/縮排前綴/是否最後一個。
    $stack = New-Object System.Collections.Generic.Stack[object]

    $roots = @()
    if ($childrenOf.ContainsKey('')) { $roots = @($childrenOf[''] | Sort-Object) }

    # 反向推入，彈出時才是正序
    for ($i = $roots.Count - 1; $i -ge 0; $i--) {
        $stack.Push([pscustomobject]@{
            Path     = $roots[$i]
            Prefix   = ''
            IsLast   = ($i -eq $roots.Count - 1)
        }) | Out-Null
    }

    while ($stack.Count -gt 0) {
        $node = $stack.Pop()
        $segs = $node.Path -split '/'
        $name = $segs[$segs.Count - 1]

        $mark = ''
        if ($addedSet.Contains($node.Path)) { $mark = ' [+]' }
        elseif ($removedSet.Contains($node.Path)) { $mark = ' [-]' }

        $branch = if ($node.IsLast) { '└─ ' } else { '├─ ' }
        $lines.Add($node.Prefix + $branch + $name + $mark) | Out-Null

        if ($childrenOf.ContainsKey($node.Path)) {
            $kids = @($childrenOf[$node.Path] | Sort-Object)
            # 子層的縮排：父節點是最後一個就用空白，否則要延續豎線
            $childPrefix = $node.Prefix + $(if ($node.IsLast) { '   ' } else { '│  ' })
            for ($i = $kids.Count - 1; $i -ge 0; $i--) {
                $stack.Push([pscustomobject]@{
                    Path   = $kids[$i]
                    Prefix = $childPrefix
                    IsLast = ($i -eq $kids.Count - 1)
                }) | Out-Null
            }
        }
    }

    return ($lines -join "`r`n")
}

<#
.SYNOPSIS
  寄出目錄樹變動通知信。

.DESCRIPTION
  設定放在 config.json 的 Mail 區段：
    "Mail": {
      "SmtpServer": "smtp.office365.com",
      "Port": 587,
      "UseSsl": true,
      "User": "someone@asiavista.com.tw",
      "Password": "應用程式密碼",
      "From": "someone@asiavista.com.tw",
      "To": [ "maintainer@asiavista.com.tw" ]
    }

  ⚠️ Microsoft 365 若帳號啟用了多重驗證，必須用「應用程式密碼」，
     一般登入密碼會被拒絕（回 5.7.57 或 SmtpAuthenticationException）。
     租用戶也可能停用了 SMTP AUTH，需請系統管理員開啟。

  寄信失敗絕不可中斷主流程：目錄樹已經推送成功了，通知信只是附加價值。
#>
function Send-TreeChangeMail {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $MailConfig,
        [Parameter(Mandatory)][string] $Subject,
        [Parameter(Mandatory)][string] $Body,
        [string] $LogFile
    )

    if (-not $MailConfig) { return $false }

    $names = $MailConfig.PSObject.Properties.Name
    foreach ($req in @('SmtpServer', 'User', 'Password', 'To')) {
        if (-not ($names -contains $req) -or -not $MailConfig.$req) {
            Write-Log -Message "郵件設定缺少 $req，略過寄信" -Level 'WARN' -LogFile $LogFile
            return $false
        }
    }

    $to = @($MailConfig.To | Where-Object { $_ })
    if ($to.Count -eq 0) {
        Write-Log -Message '郵件設定的收件者是空的，略過寄信' -Level 'WARN' -LogFile $LogFile
        return $false
    }

    $from = if ($names -contains 'From' -and $MailConfig.From) { $MailConfig.From } else { $MailConfig.User }
    $port = if ($names -contains 'Port' -and $MailConfig.Port) { [int]$MailConfig.Port } else { 587 }
    $useSsl = if ($names -contains 'UseSsl') { [bool]$MailConfig.UseSsl } else { $true }

    try {
        $msg = New-Object Net.Mail.MailMessage
        $msg.From = New-Object Net.Mail.MailAddress($from)
        foreach ($t in $to) { $msg.To.Add($t) }
        $msg.Subject = $Subject
        $msg.Body = $Body
        # 明確指定 UTF-8，否則中文目錄名在部分郵件客戶端會變亂碼
        $msg.SubjectEncoding = [Text.Encoding]::UTF8
        $msg.BodyEncoding = [Text.Encoding]::UTF8
        $msg.IsBodyHtml = $false

        $smtp = New-Object Net.Mail.SmtpClient($MailConfig.SmtpServer, $port)
        $smtp.EnableSsl = $useSsl
        $smtp.Credentials = New-Object Net.NetworkCredential($MailConfig.User, $MailConfig.Password)
        $smtp.Timeout = 60000

        $smtp.Send($msg)
        $msg.Dispose()
        $smtp.Dispose()

        Write-Log -Message ("已寄出變動通知信給 {0}" -f ($to -join '、')) -LogFile $LogFile
        return $true
    }
    catch {
        # 寄信失敗不影響目錄樹推送的結果，只記錄
        Write-Log -Message ("寄信失敗（目錄樹已推送成功，不影響上傳）：{0}" -f $_.Exception.Message) `
            -Level 'WARN' -LogFile $LogFile
        return $false
    }
}

<#
.SYNOPSIS
  呼叫 Apps Script 端點。

.DESCRIPTION
  POST 一律以 text/plain 送 JSON 字串，與 Apps Script 端 e.postData.contents
  的解析方式一致（也與 PWA 端保持同一種格式）。
  Apps Script 會 302 轉址到 script.googleusercontent.com，Invoke-RestMethod
  預設會跟隨轉址，無須額外處理。
#>
function Invoke-SnapSyncApi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Endpoint,
        [Parameter(Mandatory)][ValidateSet('GET', 'POST')][string] $Method,
        [Parameter(Mandatory)][hashtable] $Payload,
        [int] $TimeoutSec = 300
    )

    if ($Method -eq 'GET') {
        $pairs = foreach ($k in $Payload.Keys) {
            '{0}={1}' -f [Uri]::EscapeDataString($k), [Uri]::EscapeDataString([string]$Payload[$k])
        }
        $uri = '{0}?{1}' -f $Endpoint, ($pairs -join '&')
        $resp = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec $TimeoutSec
    }
    else {
        $body = $Payload | ConvertTo-Json -Depth 20 -Compress
        # 必須是 text/plain，與 Apps Script 端解析方式一致
        $resp = Invoke-RestMethod -Uri $Endpoint -Method Post `
            -ContentType 'text/plain; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
            -TimeoutSec $TimeoutSec
    }

    # Apps Script 未攔截的錯誤會回 HTML，此時 $resp 不會有 ok 屬性
    if ($null -eq $resp -or -not ($resp.PSObject.Properties.Name -contains 'ok')) {
        throw "端點回應格式非預期（可能是部署版本錯誤或端點網址不對）：$resp"
    }
    if (-not $resp.ok) {
        throw "端點回報失敗：$($resp.error) - $($resp.message)"
    }
    return $resp
}

# =====================================================================
# 照片浮水印
#
# 工程資訊寫在該目錄的 .snapsync 標記檔裡，落地時壓在照片左下角。
#
# ⚠️ 實際內容含客戶資料（施工單位、地址），一律只放在現場的 .snapsync
#    檔案裡，不得寫進本專案任何檔案——.snapsync 位於來源目錄，不進 git。
#
# 格式為每行一個「欄位:值」，例如（以下為示意，非真實資料）：
#     時　　間:YYYY.MM.DD Ddd
#     工程名稱:○○○
#     施工單位:○○○
#     施工地址:○○○
#
# 內容原樣顯示（含用於對齊的全形空白），不做解析或重新排版——
# 現場人員怎麼寫就怎麼呈現，要調整對齊自己改檔案即可。
# 檔案不存在或內容為空就不壓浮水印。
# =====================================================================

<#
.SYNOPSIS
  讀取目錄中 .snapsync 的浮水印文字；沒有內容則回傳 $null。

.PARAMETER Dir
  照片要落地的目錄。標記檔就在這個目錄裡。
#>
function Get-WatermarkText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Dir,
        [string] $MarkerName = '.snapsync',
        # 往上找的層數上限。設界限是防呆：路徑解析出錯時不會一路找到磁碟根，
        # 誤套用到別的案場的工程資訊。
        [int] $MaxUp = 8,
        [string] $RootDir
    )

    # ⚠️ 必須【往上層找】最近的標記檔，不能只看照片所在目錄。
    #
    # 這與目錄樹的開通邏輯一致：標記放在「115-8」時，它與底下所有子目錄
    # 都會納入 TREE，照片實際落在子目錄（例如 115-8\1.客美多咖啡）。
    # 只找當層的話，除非每個末端目錄都放一份標記檔，否則永遠找不到
    # （實測症狀：log 顯示落地成功但完全沒有壓浮水印的記錄）。
    #
    # 找到最近的一個就停——子目錄的標記優先於父目錄，讓個別現場可覆寫。
    $marker = $null
    $cur = $Dir
    for ($i = 0; $i -le $MaxUp -and $cur; $i++) {
        $try = Join-Path $cur $MarkerName
        if (Test-Path -LiteralPath $try) { $marker = $try; break }

        # 不可超出該根目錄，否則會撈到別的案場的資訊
        if ($RootDir -and $cur.TrimEnd('\') -ieq $RootDir.TrimEnd('\')) { break }

        $parent = Split-Path -Parent $cur
        if (-not $parent -or $parent -eq $cur) { break }   # 已到磁碟／UNC 根
        $cur = $parent
    }

    if (-not $marker) { return $null }

    try {
        # 標記檔多半由現場人員用記事本建立，可能是 UTF-8（有無 BOM）或 ANSI。
        # 先讀 UTF-8；若出現替換字元（U+FFFD）代表解碼失敗，再退回系統預設編碼。
        $text = [IO.File]::ReadAllText($marker, [Text.Encoding]::UTF8)
        if ($text -match "�") {
            $text = [IO.File]::ReadAllText($marker, [Text.Encoding]::Default)
        }
    }
    catch { return $null }

    if ([string]::IsNullOrWhiteSpace($text)) { return $null }

    # 去掉空行與前後空白，但保留行內用於對齊的空白
    $lines = @($text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
               ForEach-Object { $_.TrimEnd() })
    if ($lines.Count -eq 0) { return $null }

    return ($lines -join "`n")
}

<#
.SYNOPSIS
  在 JPEG 左下角壓上多行浮水印文字。就地覆寫原檔。

.DESCRIPTION
  用 System.Drawing 繪製。字級依照片長邊換算，不同解析度下比例才一致；
  半透明黑底條確保在淺色地面、強光牆面上都讀得到。

  ⚠️ 必須在 MD5 校驗鏈全部通過之後才呼叫——壓字會改變檔案內容，
     先壓的話落地校驗一定失敗。

.OUTPUTS
  成功回傳 $true；失敗回傳 $false（原檔不動，呼叫端仍視為落地成功）。
#>
function Add-PhotoWatermark {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Text,
        [string] $LogFile
    )

    $img = $null; $bmp = $null; $g = $null; $font = $null
    $tmp = "$Path.wm"

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop

        # 讀進記憶體再關檔：直接用 FromFile 會鎖住檔案，之後無法覆寫原檔
        $raw = [IO.File]::ReadAllBytes($Path)
        $ms = New-Object IO.MemoryStream(,$raw)
        $img = [Drawing.Image]::FromStream($ms)

        $w = $img.Width; $h = $img.Height
        $bmp = New-Object Drawing.Bitmap($w, $h)
        $bmp.SetResolution($img.HorizontalResolution, $img.VerticalResolution)

        $g = [Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.DrawImage($img, 0, 0, $w, $h)

        # 字級取長邊的 2.6%，下限 12px（小圖也要看得到）
        $fontSize = [Math]::Max(12, [int]([Math]::Max($w, $h) * 0.026))
        # 微軟正黑體：Windows 內建且支援繁體中文。缺字時 GDI+ 會自動替代
        $font = New-Object Drawing.Font('Microsoft JhengHei', $fontSize, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)

        $lines = @($Text -split "`n")
        $pad = [int]($fontSize * 0.6)
        $lineH = [int]($fontSize * 1.45)

        # 量出最寬的一行，底條才知道要多寬
        $maxW = 0
        foreach ($ln in $lines) {
            $sz = $g.MeasureString($ln, $font)
            if ($sz.Width -gt $maxW) { $maxW = $sz.Width }
        }

        $boxW = [int]($maxW + $pad * 2)
        $boxH = [int]($lines.Count * $lineH + $pad * 2)
        $boxX = 0
        $boxY = $h - $boxH

        # 半透明黑底：純文字在淺色地面上會看不見
        $brushBg = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(140, 0, 0, 0))
        $g.FillRectangle($brushBg, $boxX, $boxY, $boxW, $boxH)
        $brushBg.Dispose()

        $brushFg = New-Object Drawing.SolidBrush([Drawing.Color]::White)
        $y = $boxY + $pad
        foreach ($ln in $lines) {
            $g.DrawString($ln, $font, $brushFg, [single]($boxX + $pad), [single]$y)
            $y += $lineH
        }
        $brushFg.Dispose()

        # 以 JPEG 品質 92 存出：太低會讓浮水印文字邊緣糊掉
        $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                 Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $encParams = New-Object Drawing.Imaging.EncoderParameters(1)
        $encParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter(
            [Drawing.Imaging.Encoder]::Quality, [int64]92)

        # 先寫暫存再改名：中途失敗不會留下半截檔案
        $bmp.Save($tmp, $codec, $encParams)
        $encParams.Dispose()

        # 釋放後才能覆寫原檔
        $g.Dispose(); $g = $null
        $bmp.Dispose(); $bmp = $null
        $img.Dispose(); $img = $null
        $ms.Dispose()

        Move-Item -LiteralPath $tmp -Destination $Path -Force
        return $true
    }
    catch {
        if ($LogFile) {
            Write-Log -Message ("壓浮水印失敗（原檔保留，不影響落地）：{0}" -f $_.Exception.Message) `
                -Level 'WARN' -LogFile $LogFile
        }
        return $false
    }
    finally {
        if ($g)   { $g.Dispose() }
        if ($bmp) { $bmp.Dispose() }
        if ($img) { $img.Dispose() }
        if ($font){ $font.Dispose() }
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

<#
.SYNOPSIS
    把「還沒壓浮水印的原圖」備份到子目錄。

.DESCRIPTION
    浮水印是【破壞性】加工：壓上去就回不去了，字蓋掉的畫面內容永久消失。
    工程照片日後可能要重新出圖（換版型、字打錯、要不同語言的浮水印），
    沒有原圖就只能回工地重拍。

    因此在壓字【之前】先把驗證過的原檔複製一份到照片同層的子目錄。
    只在該目錄真的要壓浮水印時才備份——沒有 .snapsync 內容就不壓字，
    落地檔本身就是原圖，再備份一份只是白佔空間。

    ⚠️ 呼叫時機必須在 MD5 校驗鏈通過之後、Add-PhotoWatermark 之前，
       那是磁碟上唯一存在「已驗證原圖」的時間點。

.PARAMETER Path
    落地後的照片完整路徑（此時尚未壓浮水印）。

.PARAMETER DirName
    備份子目錄名稱，預設 _original。底線開頭讓它排在檔案總管最前面，
    也提示這是系統產生的目錄，不是案場資料。

.OUTPUTS
    成功回傳備份後的完整路徑；失敗回傳 $null（不拋例外）。
    備份失敗不可影響落地結果——照片已經驗證無誤地寫入磁碟了。
#>
function Backup-OriginalPhoto {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Path,
        [string] $DirName = '_original',
        [string] $LogFile
    )

    try {
        $dir = Split-Path -Parent $Path
        $backupDir = Join-Path $dir $DirName

        if (-not (Test-Path -LiteralPath $backupDir)) {
            New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        }

        $dest = Join-Path $backupDir (Split-Path -Leaf $Path)

        # 已存在就不覆寫：同名檔代表這張先前已備份過（重跑或重送），
        # 覆寫的風險是拿「已壓過浮水印的檔」蓋掉真正的原圖。
        if (Test-Path -LiteralPath $dest) {
            if ($LogFile) {
                Write-Log -Message "  原圖備份已存在，略過：$dest" -LogFile $LogFile
            }
            return $dest
        }

        Copy-Item -LiteralPath $Path -Destination $dest -Force
        return $dest
    }
    catch {
        if ($LogFile) {
            Write-Log -Message ("原圖備份失敗（不影響落地）：{0}" -f $_.Exception.Message) `
                -Level 'WARN' -LogFile $LogFile
        }
        return $null
    }
}
