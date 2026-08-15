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
        $resolved[$name] = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\')
    }

    return [pscustomobject]@{
        Endpoint   = $endpoint
        AdminToken = $adminToken
        Roots      = $resolved
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
