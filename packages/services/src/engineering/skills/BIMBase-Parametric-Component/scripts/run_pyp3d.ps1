<#
run_pyp3d.ps1 —— 自动定位 BIMBase 内嵌 Python 3.7.9 并用它运行 pyp3d 脚本。

用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File run_pyp3d.ps1 <目标脚本.py> [参数...]
    powershell -NoProfile -ExecutionPolicy Bypass -File run_pyp3d.ps1 -PrintPython

设计要点（不是随手写的，每条都对应一个踩过的坑）：
  * 定位与执行在同一个进程里完成，解释器路径不以文本形式跨进程传递
    —— 安装目录常含中文（如 D:\专业软件\...），路径一旦经 stdout 转手就可能被
    按错误编码解读，变成"找不到解释器"。
  * 不用 `import pyp3d` 判断解释器是否可用：pyp3d 靠 IPC 连接**正在运行的**
    BIMBase.exe，软件没开时 import 必然抛 RuntimeError。改看磁盘上有没有
    lib\site-packages\pyp3d 目录。
  * 磁盘兜底只按"目录名"扫三层，绝不做全盘 python.exe 递归
    —— 后者在本机实测跑满 120 秒仍未结束。
  * 结果缓存到 %LOCALAPPDATA%\bimbase_python_path.txt，之后每次都是毫秒级；
    缓存指向的文件消失（软件升级/换目录）会自动重新解析。
  * 强制 UTF-8 输出，中文 print 和 traceback 不会变成乱码。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Script,

    [switch]$PrintPython,

    [switch]$Refresh,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ErrorActionPreference = 'SilentlyContinue'
$EMBED_SUBPATH = 'PythonScript\python-3.7.9-embed-amd64\python.exe'
$CACHE_DIR = Join-Path $env:LOCALAPPDATA 'bimbase-run'
$CACHE_FILE = Join-Path $CACHE_DIR 'python_path.txt'
$NAME_PAT = '(?i)bim|pkpm'
# 扫盘时跳过的顶层目录：只会拖慢，不可能装 BIMBase
$SKIP_PAT = '(?i)^(windows|winnt|\$recycle\.bin|system volume information|perflogs|recovery|users|programdata|appdata|node_modules|\.git)$'

function Test-HasPyp3d([string]$exe) {
    Test-Path -LiteralPath (Join-Path (Split-Path -Parent $exe) 'lib\site-packages\pyp3d')
}

# 按目录名逐层筛选，最多下探三层。只列目录、不递归文件，代价可控。
function Get-DirsByName {
    $found = New-Object System.Collections.Generic.List[string]
    $roots = [System.IO.DriveInfo]::GetDrives() |
        Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } |
        ForEach-Object { $_.Name }
    foreach ($r in $roots) {
        $lv1 = Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch $SKIP_PAT }
        foreach ($a in $lv1) {
            if ($a.Name -match $NAME_PAT) { $found.Add($a.FullName) | Out-Null }
            $lv2 = Get-ChildItem -LiteralPath $a.FullName -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch $SKIP_PAT }
            foreach ($b in $lv2) {
                if ($b.Name -match $NAME_PAT) { $found.Add($b.FullName) | Out-Null }
                # 第三层只在父目录像 PKPM/BIMBase 容器时才展开（如 D:\PKPM\BIMBase\2025）
                if ($b.Name -match $NAME_PAT -or $a.Name -match $NAME_PAT) {
                    Get-ChildItem -LiteralPath $b.FullName -Directory -ErrorAction SilentlyContinue |
                        ForEach-Object { $found.Add($_.FullName) | Out-Null }
                }
            }
        }
    }
    return $found
}

function Resolve-BimbasePython {
    # 0) 环境变量显式指定（跨机器/非标准安装的逃生口）
    if ($env:BIMBASE_PYTHON -and (Test-Path -LiteralPath $env:BIMBASE_PYTHON -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $env:BIMBASE_PYTHON).Path
    }

    # 1) 上次解析结果的缓存
    if (-not $Refresh -and (Test-Path -LiteralPath $CACHE_FILE)) {
        $cached = (Get-Content -LiteralPath $CACHE_FILE -Encoding UTF8 -Raw).Trim()
        if ($cached -and (Test-Path -LiteralPath $cached -PathType Leaf)) { return $cached }
    }

    $dirs = New-Object System.Collections.Generic.List[string]
    if ($env:BIMBASE_HOME) { $dirs.Add($env:BIMBASE_HOME) | Out-Null }

    # 2) 正在运行的 BIMBase 进程（软件开着时最准，多版本并存也不会认错）
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*bim*' -and $_.ExecutablePath } |
        ForEach-Object {
            if (([string]$_.Name).ToLower() -notmatch 'update|setup|install|uninstall|crash|report|daemon|service|helper|launcher') {
                $dirs.Add((Split-Path -Parent $_.ExecutablePath)) | Out-Null
            }
        }

    # 3) 注册表：PKPM 安装项 + 卸载项里的 InstallLocation
    #    绝不用 -Recurse：本机实测对**不存在**的注册表路径做 `-Recurse -Depth 2`
    #    要跑满 285 秒才返回 0 条。先 Test-Path，再手工展开两层。
    function Read-InstallValues($key) {
        if (-not $key) { return }
        foreach ($n in @('InstallPath', 'InstallLocation', 'Path', 'Home', 'InstallDir')) {
            $v = $key.GetValue($n); if ($v) { $dirs.Add([string]$v) | Out-Null }
        }
    }
    foreach ($root in @('HKLM:\SOFTWARE\PKPM', 'HKLM:\SOFTWARE\WOW6432Node\PKPM', 'HKCU:\SOFTWARE\PKPM')) {
        if (-not (Test-Path -Path $root)) { continue }
        Read-InstallValues (Get-Item -Path $root -ErrorAction SilentlyContinue)
        Get-ChildItem -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
            Read-InstallValues $_
            Get-ChildItem -Path $_.PSPath -ErrorAction SilentlyContinue | ForEach-Object { Read-InstallValues $_ }
        }
    }
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        Get-ChildItem -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
            $name = [string]$_.GetValue('DisplayName')
            $loc = [string]$_.GetValue('InstallLocation')
            if (-not $loc) { $icon = [string]$_.GetValue('DisplayIcon'); if ($icon) { $loc = Split-Path -Parent ($icon -split ',')[0] } }
            if ($loc -and ($name -match '(?i)bim' -or $loc -match '(?i)bimbase|pkpm')) { $dirs.Add($loc) | Out-Null }
        }
    }

    # 逐个候选派生解释器路径并校验存在（不同版本目录布局不同，不能想当然）
    function Select-Valid([System.Collections.Generic.List[string]]$cands) {
        $ok = New-Object System.Collections.Generic.List[string]
        foreach ($d in ($cands | Select-Object -Unique)) {
            if ([string]::IsNullOrWhiteSpace($d)) { continue }
            $exe = Join-Path $d $EMBED_SUBPATH
            if (Test-Path -LiteralPath $exe -PathType Leaf) { $ok.Add($exe) | Out-Null }
        }
        return $ok
    }

    $valid = Select-Valid $dirs

    # 4) 兜底：软件没开 + 注册表没记录 + 装在非标准目录（如 D:\专业软件\...）
    if ($valid.Count -eq 0) {
        $valid = Select-Valid (Get-DirsByName)
    }

    $valid = $valid | Select-Object -Unique
    if (-not $valid -or @($valid).Count -eq 0) { return $null }

    # 带 pyp3d 的优先，其次取最新的
    $chosen = $valid | Sort-Object -Property `
        @{ Expression = { Test-HasPyp3d $_ }; Descending = $true }, `
        @{ Expression = { (Get-Item -LiteralPath $_).LastWriteTime }; Descending = $true } |
        Select-Object -First 1

    if (-not (Test-Path -LiteralPath $CACHE_DIR)) { New-Item -ItemType Directory -Path $CACHE_DIR -Force | Out-Null }
    Set-Content -LiteralPath $CACHE_FILE -Value $chosen -Encoding UTF8
    return $chosen
}

$py = Resolve-BimbasePython
if (-not $py) {
    Write-Error @'
未找到 BIMBase 内嵌 Python 解释器。
请设环境变量 BIMBASE_PYTHON 指向 ...\PythonScript\python-3.7.9-embed-amd64\python.exe，
或设 BIMBASE_HOME 指向 BIMBase 安装目录后重试。切勿改用系统 python —— pyp3d 只存在于内嵌解释器中。
'@
    exit 3
}

if ($PrintPython -or -not $Script) {
    Write-Output $py
    exit 0
}

if (-not (Test-Path -LiteralPath $Script -PathType Leaf)) {
    Write-Error "目标脚本不存在: $Script"
    exit 4
}

# 让中文 print / traceback 原样回传，不受控制台代码页影响
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

& $py $Script @ScriptArgs
exit $LASTEXITCODE
