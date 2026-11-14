// 给 release.ps1 打两个补丁，保持原编码（UTF-8 with BOM）不变。
//
// 为什么用脚本改而不是直接编辑：
// 这个文件带 BOM 且全中文注释，编辑工具容易把编码改掉；
// 一旦丢了 BOM，PowerShell 5.1 会按 GBK 解码，整份脚本解析失败。
// 所以这里显式读 UTF-8、显式写回 BOM。
//
// 为什么用短锚点：
// 长模板里的分隔横线数量必须和原文一字不差，我数错过一次，
// includes() 静默返回 false 却毫无提示。锚点越短越不容易错。
import fs from 'node:fs';

const P = 'D:\\Tool\\AIrpg\\release.ps1';
const raw = fs.readFileSync(P, 'utf8');
const hadCRLF = raw.includes('\r\n');
let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const checks = [];

function patch(label, from, to) {
  if (text.includes(to)) {
    checks.push(`· ${label}：已存在，跳过`);
    return;
  }
  if (!text.includes(from)) {
    checks.push(`✗ ${label}：未找到原文`);
    return;
  }
  text = text.split(from).join(to);
  checks.push(`✓ ${label}`);
}

// ---- 补丁 1：打包前关掉正在运行的实例 -------------------------------------
// 根目录 exe 被占用时 move-artifact 挪不动新产物，整条发布链白跑。
patch(
  '打包前关闭实例',
  "Step 2 '打包 exe'\n",
  `Step 2 '打包 exe'

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
`
);

// ---- 补丁 2：产物位置断言 -------------------------------------------------
// 硬规则：exe 只放项目根目录，dist\ 顶层不留 exe。
patch(
  '产物位置断言',
  'Ok "COC跑团.exe  ($sizeMB MB)"\n',
  `Ok "COC跑团.exe  ($sizeMB MB)  ->  项目根目录"

# dist\\ 顶层不允许留 exe：唯一产物必须在根目录。
# move-artifact 已经清过一次，这里再兜底校验，防止将来脚本被改动后悄悄回退。
$stray = Get-ChildItem (Join-Path $root 'dist') -Filter '*.exe' -File -ErrorAction SilentlyContinue
if ($stray) {
  $names = ($stray | ForEach-Object { $_.Name }) -join '、'
  Die "dist\\ 顶层还有 exe：$names。产物只应放在根目录，请清理后重试。"
}
Ok 'dist\\ 顶层无 exe（仅保留 win-unpacked 供开发模式）'
`
);

// 换行风格跟随原文件，避免整文件 diff
const out = hadCRLF ? text.replace(/\n/g, '\r\n') : text;

// 显式写回 UTF-8 BOM：丢了 BOM，PowerShell 5.1 会把中文读成乱码
fs.writeFileSync(P, '\uFEFF' + out, 'utf8');

console.log(checks.join('\n'));
console.log(`\n换行: ${hadCRLF ? 'CRLF' : 'LF'}`);
console.log(`大小: ${fs.statSync(P).size} 字节`);

const b = fs.readFileSync(P);
console.log(`前 3 字节: ${b[0]},${b[1]},${b[2]}  (239,187,191 = UTF-8 BOM)`);
