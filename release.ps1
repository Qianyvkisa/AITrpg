# ---------------------------------------------------------------------------
# 一键发布：测试 → 打包 exe → 提交 → 推送
#
# 用法：
#   .\release.ps1                     提交信息自动按改动生成
#   .\release.ps1 -Message "修复存档"   指定提交信息
#   .\release.ps1 -SkipTest           跳过测试（不推荐）
#   .\release.ps1 -NoPush             只提交不推送
#
# 说明：
#   - 打包用 NODE_OPTIONS=--use-system-ca 绕过本机代理证书导致的 TLS 校验失败
#   - exe / dist / node_modules / .udata 均已被 .gitignore 忽略，不会进仓库
#   - 任何一步失败立即停下，不会带着坏代码继续往后走
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$Message,
  [switch]$SkipTest,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$git  = 'C:\Program Files\Git\cmd\git.exe'
$node = 'C:\Users\junyu\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

if (-not (Test-Path $git))  { throw "找不到 git：$git" }
if (-not (Test-Path $node)) { throw "找不到 node：$node" }

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)        { Write-Host "  OK  $text" -ForegroundColor Green }
function Die($text)       { Write-Host "  失败：$text" -ForegroundColor Red; exit 1 }

# ---- 0. 确认是 git 仓库且有远程 -------------------------------------------
Step 0 '检查仓库'
$remote = (& $git remote) 2>$null
if (-not $remote) {
  Die "没有配置 remote。先执行：git remote add origin <仓库地址>"
}
Ok "remote: $(& $git remote get-url origin)"

# ---- 1. 跑测试 -------------------------------------------------------------
if ($SkipTest) {
  Write-Host '  跳过测试（-SkipTest）' -ForegroundColor Yellow
} else {
  Step 1 '运行测试'
  & $node tests\rules.test.mjs
  if ($LASTEXITCODE -ne 0) { Die 'rules.test.mjs 未通过' }
  & $node tests\unit.test.mjs
  if ($LASTEXITCODE -ne 0) { Die 'unit.test.mjs 未通过' }
  & $node tests\occupations.test.mjs
  if ($LASTEXITCODE -ne 0) { Die 'occupations.test.mjs 未通过' }
  & $node tests\charEditor.smoke.mjs
  if ($LASTEXITCODE -ne 0) { Die 'charEditor.smoke.mjs 未通过' }
  & $node tests\messages.dom.test.mjs
  if ($LASTEXITCODE -ne 0) { Die 'messages.dom.test.mjs 未通过' }
  Ok '全部测试通过'
}

# ---- 2. 打包 exe -----------------------------------------------------------
Step 2 '打包 exe'
# 本机代理有中间人证书，不加这个会报 unable to verify the first certificate
$env:NODE_OPTIONS = '--use-system-ca'
& $node node_modules\electron-builder\out\cli\cli.js --win portable
if ($LASTEXITCODE -ne 0) { Die '打包失败' }
& $node tools\move-artifact.mjs
if ($LASTEXITCODE -ne 0) { Die '移动产物失败' }
$exe = Join-Path $root 'COC跑团.exe'
if (-not (Test-Path $exe)) { Die '根目录没有生成 exe' }
$sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Ok "COC跑团.exe  ($sizeMB MB)"

# ---- 3. 提交 ---------------------------------------------------------------
Step 3 '提交改动'
$pending = (& $git status --porcelain) 2>$null
if (-not $pending) {
  Ok '工作区干净，无需提交'
} else {
  & $git add -A
  if (-not $Message) {
    # 没给提交信息时，用改动的文件名生成一条可读的
    $files = (& $git diff --cached --name-only) 2>$null
    $Message = '更新 ' + (($files | Select-Object -First 3) -join '、')
    if ($files.Count -gt 3) { $Message += " 等 $($files.Count) 个文件" }
  }
  & $git commit -m $Message
  if ($LASTEXITCODE -ne 0) { Die '提交失败' }
  Ok "已提交：$Message"
}

# ---- 4. 推送 ---------------------------------------------------------------
if ($NoPush) {
  Write-Host '  跳过推送（-NoPush）' -ForegroundColor Yellow
  exit 0
}

Step 4 '推送到 GitHub'
& $git push -u origin main
if ($LASTEXITCODE -ne 0) { Die '推送失败（多半是没登录，见下方提示）' }
Ok '推送完成'

Write-Host "`n全部完成。" -ForegroundColor Green
