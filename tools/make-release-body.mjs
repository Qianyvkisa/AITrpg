// ---------------------------------------------------------------------------
// 生成 v0.1.5 Release 的正文 JSON
//
// 为什么要用 Node 而不是 PowerShell：
//   上次直接用 PowerShell 的 ConvertTo-Json 构造请求体，结果 GitHub 上
//   中文全变成了 "?"——PowerShell 5.1 在把字符串转成请求体时会按本地代码页
//   处理，UTF-8 的中文就这样丢了。改用 Node 明确写出 UTF-8 文件，不经过
//   PowerShell 的编码转换，就不会再出这个问题。
//
// 输出：tools\ui\shots\release-body.json（UTF-8 无 BOM）
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/ 的上一级才是项目根目录
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tools', 'ui', 'shots', 'release-body.json');

const body = `## 修复

- **启动画面被主窗口遮挡**：主窗口原本在 splash 出现后约 100ms 就盖上来，用户几乎看不到启动画面。现在主窗口会等 splash 退场后再显示，两者完全不重叠（实测 splash 独占约 850ms）。
- **release.ps1 漏跑测试**：改为自动发现 \`tests/\` 下所有测试文件，不再维护手写清单（此前漏了 ruleBook、charStore、gameSetup 三个）。
- **release.ps1 稳定性**：修复编辑丢 BOM 导致中文乱码、\`*> $null\` 误判测试失败、子进程 stderr 被当作致命错误等问题；新增版本一致性校验与显式退出码。

## 已知问题

portable exe 每次启动需先解压，从双击到窗口出现约 7.8 秒（win-unpacked 版本仅 1.4 秒）。这是便携包固有限制，暂未改动。

## 下载

下载下方 \`COC-Keeper-v0.1.5-win-x64-portable.exe\`，双击即可运行，无需安装。
`;

const payload = {
  body,
  name: 'v0.1.5'
};

// 显式写 UTF-8、不带 BOM
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

// 读回来确认中文没有丢失
const readBack = JSON.parse(readFileSync(out, 'utf8'));
console.log('已写入:', out);
console.log('正文字符数:', readBack.body.length);
console.log('中文完好:', /启动画面被主窗口遮挡/.test(readBack.body));
console.log('问号污染:', readBack.body.includes('??'));
