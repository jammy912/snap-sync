# =====================================================================
# New-FolderTemplate.ps1 — 建立五層目錄範本
#
# 依範本一次建好工地照片的資料夾結構，供 Push-Tree.ps1 掃描成目錄樹。
#
# 【層級定義】手機上看到的五層 = 根名稱（第 1 層）+ 實體資料夾四層。
#   Push-Tree.ps1 會把 config.json 的根名稱當作目錄樹第一層，
#   所以實體只需建到第 4 層（見 Push-Tree.ps1:65 的 $fullRel）。
#
#     第1層 根名稱      工程            ← 來自 config.json 的 Roots，不是實體資料夾
#     第2層 專案        A棟新建工程
#     第3層 樓層/區域    3F
#     第4層 工項        結構體
#     第5層 施工階段    施工中
#
#   實際落地路徑：D:\工地照片\A棟新建工程\3F\結構體\施工中\<照片>
#
# 【預設是乾跑】不加 -Apply 只會列出將建立的目錄，不會真的動硬碟。
#
# 用法：
#   .\New-FolderTemplate.ps1 -BasePath 'D:\工地照片'                     # 預覽
#   .\New-FolderTemplate.ps1 -BasePath 'D:\工地照片' -Apply              # 實際建立
#   .\New-FolderTemplate.ps1 -BasePath 'D:\工地照片' -Projects 'B棟' -Apply
#   .\New-FolderTemplate.ps1 -BasePath 'D:\工地照片' -TemplateFile .\tpl.json -Apply
#
# ※ 本檔含中文，必須存成 UTF-8 with BOM。
# =====================================================================

[CmdletBinding()]
param(
    # 建立的根位置，對應 config.json 中某個 Roots 的實體路徑
    [Parameter(Mandatory = $true)]
    [string] $BasePath,

    # 第2層：專案。實務上每次開新專案只會加這一個
    [string[]] $Projects = @('範例專案'),

    # 第3層：樓層／區域
    [string[]] $Areas = @('B1', '1F', '2F', '3F', '頂樓', '基地外圍'),

    # 第4層：工項
    [string[]] $Works = @('假設工程', '基礎工程', '結構體', '機電', '裝修', '外牆', '防水', '雜項'),

    # 第5層：施工階段
    [string[]] $Stages = @('施工前', '施工中', '完成', '缺失改善'),

    # 用 JSON 覆寫上面四層的清單（見檔尾範例）
    [string] $TemplateFile,

    # 不加這個參數就只是預覽，不會真的建立
    [switch] $Apply,

    [string] $LogFile = (Join-Path $PSScriptRoot 'logs\folder-template.log')
)

. (Join-Path $PSScriptRoot 'Common.ps1')

try {
    # ---- 讀取範本檔（若有指定）----
    if ($TemplateFile) {
        if (-not (Test-Path -LiteralPath $TemplateFile)) {
            throw "範本檔不存在：$TemplateFile"
        }
        $tpl = Get-Content -LiteralPath $TemplateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($tpl.Projects) { $Projects = @($tpl.Projects) }
        if ($tpl.Areas)    { $Areas    = @($tpl.Areas) }
        if ($tpl.Works)    { $Works    = @($tpl.Works) }
        if ($tpl.Stages)   { $Stages   = @($tpl.Stages) }
        Write-Log -Message "已套用範本檔：$TemplateFile" -LogFile $LogFile
    }

    # ---- 檢查名稱合法性 ----
    # 這些字元在 Windows 檔名不合法；'/' 另外會破壞目錄樹的路徑分隔
    $invalid = [IO.Path]::GetInvalidFileNameChars()
    foreach ($set in @(
        @{ Name = 'Projects'; Values = $Projects },
        @{ Name = 'Areas';    Values = $Areas },
        @{ Name = 'Works';    Values = $Works },
        @{ Name = 'Stages';   Values = $Stages }
    )) {
        foreach ($v in $set.Values) {
            if ([string]::IsNullOrWhiteSpace($v)) {
                throw "$($set.Name) 含空白名稱"
            }
            if ($v.IndexOfAny($invalid) -ge 0) {
                throw "$($set.Name) 的「$v」含不合法字元（不可用 \ / : * ? `" < > |）"
            }
        }
    }

    $total = $Projects.Count * $Areas.Count * $Works.Count * $Stages.Count
    Write-Log -Message ("範本：{0} 專案 x {1} 區域 x {2} 工項 x {3} 階段 = {4} 個末端目錄" -f `
        $Projects.Count, $Areas.Count, $Works.Count, $Stages.Count, $total) -LogFile $LogFile

    # 目錄樹列數會直接反映到手機選單與 TREE 分頁，太多會難選也拖慢載入
    if ($total -gt 2000) {
        Write-Log -Message "末端目錄達 $total 個，手機選單會很難操作，建議縮減層級清單" `
            -Level 'WARN' -LogFile $LogFile
    }

    if (-not (Test-Path -LiteralPath $BasePath)) {
        if ($Apply) {
            New-Item -ItemType Directory -Path $BasePath -Force | Out-Null
            Write-Log -Message "已建立根目錄：$BasePath" -LogFile $LogFile
        } else {
            Write-Output "（根目錄不存在，實際執行時會建立）$BasePath"
        }
    }

    $created = 0
    $existed = 0

    foreach ($proj in $Projects) {
        foreach ($area in $Areas) {
            foreach ($work in $Works) {
                foreach ($stage in $Stages) {
                    $path = Join-Path $BasePath (Join-Path $proj (Join-Path $area (Join-Path $work $stage)))

                    if (Test-Path -LiteralPath $path) {
                        $existed++
                        continue
                    }

                    if ($Apply) {
                        # -Force 對「目錄」是「已存在就不報錯」，不會刪既有內容
                        New-Item -ItemType Directory -Path $path -Force | Out-Null
                    } else {
                        Write-Output $path
                    }
                    $created++
                }
            }
        }
    }

    if ($Apply) {
        Write-Log -Message "完成：新建 $created 個、已存在 $existed 個（根：$BasePath）" -LogFile $LogFile
        Write-Output ""
        Write-Output "已建立 $created 個目錄（$existed 個原本就有）。"
        Write-Output "下一步：執行 .\Push-Tree.ps1 把目錄樹推上雲端，手機才看得到。"
    } else {
        Write-Output ""
        Write-Output "以上為預覽，共 $created 個待建立、$existed 個已存在。"
        Write-Output "確認無誤後加上 -Apply 實際建立："
        Write-Output "  .\New-FolderTemplate.ps1 -BasePath '$BasePath' -Apply"
    }
    exit 0
}
catch {
    Write-Log -Message "執行失敗：$($_.Exception.Message)" -Level 'ERROR' -LogFile $LogFile
    Write-Output "失敗：$($_.Exception.Message)"
    exit 1
}

# =====================================================================
# 範本檔格式（-TemplateFile 用），存成 UTF-8：
#
# {
#   "Projects": ["A棟新建工程", "B棟整修"],
#   "Areas":    ["B1", "1F", "2F", "3F", "頂樓"],
#   "Works":    ["假設工程", "結構體", "機電", "裝修"],
#   "Stages":   ["施工前", "施工中", "完成", "缺失改善"]
# }
# =====================================================================
