# ---------------------------------------------------------------------------
# 一键发布：测试 → 打包 exe → 校验 → 提交 → 推送 → 上传 GitHub Release
#
# 用法：
#   .\release.ps1                     自动选择当前版本的下一个 fix 编号
#   .\release.ps1 -Message "修复存档"   指定提交信息
#   .\release.ps1 -Fix 1 -NotesFile .\release-notes.md  指定编号和 Markdown 正文
#   .\release.ps1 -SkipTest           跳过测试（不推荐）
#   .\release.ps1 -NoPush             只提交不推送
#   .\release.ps1 -NoCommit           只测试+打包，不提交不推送（出完产物等人确认）
#
# 说明：
#   - 打包用 NODE_OPTIONS=--use-system-ca 绕过本机代理证书导致的 TLS 校验失败
#   - exe / dist / node_modules / .udata 均已被 .gitignore 忽略，不会进仓库
#   - 任何一步失败立即停下，不会带着坏代码继续往后走
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$Message,
  [ValidateRange(0, 2147483647)] [int]$Fix,
  [string]$NotesFile,
  [switch]$SkipTest,
  [switch]$NoPush,
  [switch]$NoCommit
)

$ErrorActionPreference = 'Stop'
# 但不要把子进程写到 stderr 的内容当成致命错误：
# 有些测试会故意触发错误路径（比如 charStore 写入坏 JSON 验证容错），
# 那条 stderr 是预期输出，不代表测试失败。是否失败只看退出码。
$PSNativeCommandUseErrorActionPreference = $false
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
$remote = (& $git remote get-url --push origin) 2>$null
if ($LASTEXITCODE -ne 0 -or -not $remote) {
  Die "没有配置 remote。先执行：git remote add origin <仓库地址>"
}
Ok '已找到 origin'

# ---- 1. 跑测试 -------------------------------------------------------------
if ($SkipTest) {
  Write-Host '  跳过测试（-SkipTest）' -ForegroundColor Yellow
} else {
  Step 1 '运行测试'
  # 自动发现 tests\ 下所有测试，而不是写死清单：
  # 写死的清单漏过两次（ruleBook、charStore 都没跟上），
  # 结果是"发布时测试全绿"其实根本没跑那几个。
  $tests = Get-ChildItem (Join-Path $root 'tests') -Filter '*.test.mjs' |
           Sort-Object Name
  $smokes = Get-ChildItem (Join-Path $root 'tests') -Filter '*.smoke.mjs' |
            Sort-Object Name
  $all = @($tests) + @($smokes)

  if (-not $all.Count) { Die 'tests 目录下没有找到任何测试' }

  $failed = @()
  foreach ($t in $all) {
    Write-Host "  - $($t.Name)" -NoNewline
    # 注意用 `> $null 2>&1` 而不是 `*> $null`：
    # 后者在某些情况下会让 $LASTEXITCODE 取到重定向本身的结果，
    # 把明明通过的测试误判成失败（我踩过一次，rules.test 单跑 138 项全过却被报失败）。
    # 用 cmd 中转：PowerShell 5.1 在 $ErrorActionPreference=Stop 时，
    # 子进程写 stderr 会被当成终止性错误直接中断脚本（即使退出码是 0）。
    # 而 charStore 等测试会故意触发错误路径，stderr 是预期输出。
    # 交给 cmd 跑，PowerShell 就只看到退出码。
    & cmd /c "`"$node`" `"$($t.FullName)`" > nul 2>&1"
    if ($LASTEXITCODE -ne 0) {
      $failed += $t.Name
      Write-Host '  失败' -ForegroundColor Red
      # 失败时重跑一次并把输出放出来，否则看不到为什么失败
      & $node $t.FullName
    } else {
      Write-Host '  OK' -ForegroundColor Green
    }
  }

  if ($failed.Count) { Die ("测试未通过：" + ($failed -join '、')) }
  Ok "全部测试通过（$($all.Count) 个文件）"
}

# ---- 1.5 版本一致性检查 ----------------------------------------------------
# 踩过的坑：提交信息里写了 "v0.1.5"，但 package.json 还是 0.1.4，
# 结果 exe 版本号对不上提交信息，发出去的东西和记录不一致。
# 这里做一次交叉校验：提交信息里出现的 vX.Y.Z 必须和 package.json 一致。
$pkgVersion = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Message -and ($Message -match 'v(\d+\.\d+\.\d+)')) {
  $claimed = $Matches[1]
  if ($claimed -ne $pkgVersion) {
    Die "提交信息里写的是 v$claimed，但 package.json 是 $pkgVersion。先改 package.json 再发布。"
  }
  Ok "版本一致：v$pkgVersion"
} else {
  Ok "当前版本：v$pkgVersion"
}

if (-not $NoCommit -and -not $NoPush) {
  if ((& $git branch --show-current) -ne 'main') { Die '请在 main 分支发布' }
  if ($remote -notmatch '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?/?$') {
    Die 'origin 必须是 GitHub 仓库地址'
  }
  $repository = $Matches[1]
  if ($NotesFile) { $NotesFile = (Resolve-Path -LiteralPath $NotesFile).Path }

  if (-not $Fix) {
    $remoteTags = & $git ls-remote --tags --refs origin "refs/tags/v$pkgVersion-fix*"
    if ($LASTEXITCODE -ne 0) { Die '无法查询 GitHub 上已使用的修复编号' }
    $pattern = "refs/tags/v$([regex]::Escape($pkgVersion))-fix([1-9][0-9]*)\s*$"
    $latest = 0
    foreach ($line in $remoteTags) {
      if ($line -match $pattern) { $latest = [Math]::Max($latest, [int]$Matches[1]) }
    }
    $Fix = $latest + 1
  }
  $tag = "v$pkgVersion-fix$Fix"
  Ok "发布标签：$tag"
}
# ---- 2. 打包 exe -----------------------------------------------------------
Step 2 '打包 exe'

# 打包前先关掉正在运行的实例。
# 踩过的坑：Windows 会锁住正在执行的 exe，根目录那份被占用时
# move-artifact 挪不动新产物，整条发布链在最后一步前功尽弃。
$running = Get-Process -Name 'COC跑团' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "  关闭运行中的实例（$($running.Count) 个进程）" -ForegroundColor Yellow
  $running | ForEach-Object { $_.Kill() }
  Start-Sleep -Seconds 2
  $still = Get-Process -Name 'COC跑团' -ErrorAction SilentlyContinue
  if ($still) { Die '有实例关不掉，请手动结束进程后重试' }
  Ok '已关闭'
}
# 本机代理有中间人证书，不加这个会报 unable to verify the first certificate
$env:NODE_OPTIONS = '--use-system-ca'

# electron-builder 打包时要下载 electron 运行时 zip。
# 直连 GitHub 在这台机器上会 ETIMEDOUT，必须走国内镜像。
# 注意：.npmrc 里的 electron_mirror 只管 npm/pnpm 安装阶段，
# electron-builder 读的是环境变量，两者互不相通，必须在这里单独设。
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
# 先应用自定义便携版启动器模板（跳过重复解压，让动画能立刻出现），再打包
& $node tools\patch-portable-nsi.mjs
if ($LASTEXITCODE -ne 0) { Die '应用便携版模板失败' }
& $node node_modules\electron-builder\out\cli\cli.js --win portable
if ($LASTEXITCODE -ne 0) { Die '打包失败' }
& $node tools\move-artifact.mjs
if ($LASTEXITCODE -ne 0) { Die '移动产物失败' }
$exe = Join-Path $root 'COC跑团.exe'
if (-not (Test-Path $exe)) { Die '根目录没有生成 exe' }
$sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Ok "COC跑团.exe  ($sizeMB MB)  ->  项目根目录"

# dist\ 顶层不允许留 exe：唯一产物必须在根目录。
# move-artifact 已经清过一次，这里再兜底校验，防止将来脚本被改动后悄悄回退。
$stray = Get-ChildItem (Join-Path $root 'dist') -Filter '*.exe' -File -ErrorAction SilentlyContinue
if ($stray) {
  $names = ($stray | ForEach-Object { $_.Name }) -join '、'
  Die "dist\ 顶层还有 exe：$names。产物只应放在根目录，请清理后重试。"
}
Ok 'dist\ 顶层无 exe（仅保留 win-unpacked 供开发模式）'

# ---- 2.4 asar 内容校验 -----------------------------------------------------
# 打包成功不等于内容齐全：漏一个 themes.css 的表现是「exe 能开、界面全白」，
# 而 electron-builder 自己不会为此报错（src/**/* 匹配不到也算成功）。
# 这里按文件名点名核对，缺一个就停下。
& $node tools\verify-asar.mjs
if ($LASTEXITCODE -ne 0) { Die 'asar 内容校验失败' }
Ok 'asar 内容校验通过'

# ---- 2.5 只打包模式 --------------------------------------------------------
# -NoCommit：产物已就位，停在这里等用户确认要不要发布。
# 不碰 git，工作区保持原样（该脏就脏），用户想提交时自己跑 release.ps1 即可。
if ($NoCommit) {
  Write-Host ""
  Write-Host "  已跳过提交与推送（-NoCommit）" -ForegroundColor Yellow
  Write-Host "  产物：$exe" -ForegroundColor Green
  Write-Host "  确认要发布时，去掉 -NoCommit 再跑一次即可。" -ForegroundColor Yellow
  exit 0
}

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
  Write-Host '  跳过推送与 Release 上传（-NoPush）' -ForegroundColor Yellow
  exit 0
}

Step 4 '推送源码和发布标签'
$commit = & $git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { Die '无法取得本次发布的提交' }
& $git push --atomic -u origin main "${commit}:refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { Die '推送失败（多半是没登录，见下方提示）' }
Ok '推送完成'

Step 5 '上传 GitHub Release'
$shellName = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh.exe' }
$shellPath = Join-Path $PSHOME $shellName
$releaseArgs = @('--repo', $repository, '--tag', $tag, '--commit', $commit, '--powershell', $shellPath)
if ($NotesFile) {
  $releaseArgs += @('--notes-file', $NotesFile)
} else {
  $title = & $git log -1 --format=%s HEAD
  $releaseArgs += @('--message', $title)
}

$originalToken = $env:GH_TOKEN
try {
  if (-not $env:GH_TOKEN -and -not $env:GITHUB_TOKEN) {
    $env:GH_TOKEN = (& (Join-Path $root 'tools\get-gh-token.ps1')).Trim()
  }
  & $node tools\publish-release.mjs @releaseArgs
  if ($LASTEXITCODE -ne 0) { throw '上传或发布步骤失败' }
} catch {
  Die "GitHub Release $tag 未完成。修复问题后用 -Fix $Fix 重试。$($_.Exception.Message)"
} finally {
  $env:GH_TOKEN = $originalToken
}

Write-Host "`n全部完成。" -ForegroundColor Green
exit 0
