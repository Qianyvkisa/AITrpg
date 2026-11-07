# ---------------------------------------------------------------------------
# 截屏记录「双击 → 动画出现」的过程（开发用）
#
# 前提：缓存已建立（首次启动会解压 10 秒，那时屏幕是空的，没有截屏意义）
#
# 为什么需要：日志只能证明窗口被创建，证明不了用户看见了什么。
# 这里按毫秒级时间点连拍，再逐帧比对，才能确认屏幕上真的出现了动画。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\capture-fast-start.ps1
# 产物：.shots-fast\t{毫秒}.png
# ---------------------------------------------------------------------------
param(
  [string]$Exe = 'D:\Tool\AIrpg\COC跑团.exe',
  [string]$OutDir = 'D:\Tool\AIrpg\.shots-fast'
)

# 注意：ErrorActionPreference 必须在 param 块之后设置。
# 写在 param 之前不生效，且 Remove-Item env:xxx 在变量不存在时会报终止性错误，
# 导致脚本静默退出、一张截图都不生成（踩过）。
$ErrorActionPreference = 'SilentlyContinue'
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# 目录可能为空，直接管道会因「找不到对象」而中断，所以加 -ErrorAction 兜底
Get-ChildItem $OutDir -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.ProcessName -like '*COC*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1500

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$sw = $b.Width; $sh = $b.Height

# 时间点：覆盖「启动器几乎瞬时 → 动画窗口出现」这段
$times = @(100, 200, 300, 400, 500, 650, 800, 1000, 1300, 1700)

$t0 = [Diagnostics.Stopwatch]::StartNew()
Start-Process $Exe | Out-Null

foreach ($t in $times) {
  while ($t0.Elapsed.TotalMilliseconds -lt $t) { Start-Sleep -Milliseconds 5 }
  $bmp = New-Object System.Drawing.Bitmap($sw, $sh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $name = ('t{0:0000}ms.png' -f $t)
  $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "captured $name"
}

Get-Process | Where-Object { $_.ProcessName -like '*COC*' } | Stop-Process -Force
Write-Host 'done'
