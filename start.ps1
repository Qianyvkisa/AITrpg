# 启动 COC 跑团桌面应用（开发模式，直接用源码目录跑 Electron）

# 关键：必须隔离父进程的 ELECTRON_RUN_AS_NODE 环境变量。
# 该变量会让 electron.exe 退化成纯 Node 解释器，不创建窗口，
# 表现为“双击没反应”。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 自动定位 electron 二进制（不写死版本号）
# 优先用 dist\win-unpacked 里那份（打包流程生成，不受沙箱残留的
# Low 完整性标签影响）；其次才回落到 node_modules。
$electron = $null
$packaged = Join-Path $root 'dist\win-unpacked\COC跑团.exe'
if (Test-Path $packaged) { $electron = $packaged }

if (-not $electron) {
    $candidates = Get-ChildItem (Join-Path $root 'node_modules\.pnpm') -Directory -Filter 'electron@*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($c in $candidates) {
        $exe = Join-Path $c.FullName 'node_modules\electron\dist\electron.exe'
        if (Test-Path $exe) { $electron = $exe; break }
    }
}
if (-not $electron) {
    $flat = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (Test-Path $flat) { $electron = $flat }
}

if (-not $electron) {
    Write-Host "找不到 Electron，请先运行 pnpm install 或先打包" -ForegroundColor Red
    exit 1
}

$userData = Join-Path $root '.udata'
if (-not (Test-Path $userData)) { New-Item -ItemType Directory -Force -Path $userData | Out-Null }

$argList = "--no-sandbox --user-data-dir=`"$userData`" `"$root`""

Write-Host "启动 COC 跑团..." -ForegroundColor Cyan

# 在本进程内先摘掉 ELECTRON_RUN_AS_NODE，子进程默认继承当前环境，
# 这样不必给 ProcessStartInfo 设置 EnvironmentVariables（那会与
# UseShellExecute 冲突）。不改回原值，因为本脚本启动完就退出。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_NO_ATTACH_CONSOLE = '1'

# 用 Start-Process 启动：子进程与本脚本解耦，脚本退出后应用继续运行
$proc = Start-Process -FilePath $electron -ArgumentList $argList -WorkingDirectory $root -PassThru

Write-Host "已启动 (PID $($proc.Id))" -ForegroundColor Green
