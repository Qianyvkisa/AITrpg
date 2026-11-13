// ---------------------------------------------------------------------------
// 生成 v0.3.1 Release 的正文 JSON
//
// 用 Node 明确写 UTF-8 文件，不经过 PowerShell 的编码转换，避免中文变问号。
//
// 输出：tools\ui\shots\release-body.json（UTF-8 无 BOM）
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const VERSION = `v${pkg.version}`;
const outDir = join(root, 'tools', 'ui', 'shots');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'release-body.json');

const body = `## 修复：「（继续推进剧情，让调查员们继续行动）」不再出现在对话里

每次点「推进」都会在对话流里冒出一句：

\`\`\`
你：（继续推进剧情，让调查员们继续行动）
\`\`\`

这不是玩家打的字，是程序在你没输入内容时补的一句占位语，用来催守密人往下写。问题是它被当成**玩家发言**摆进了对话里——看起来就像自己说了句从没说过的话，很出戏。

### 改了什么

这句话现在**不再显示在界面上**，但仍然会作为上下文发给 AI（不然 AI 不知道这一轮要往下推进）。

顺带修了两处相关的：

- **场景事件不再记录它**。场景事件会进系统提示词（「已发生的关键事件」），以前堆着一串「玩家：继续推进剧情」，既占 token 又可能让 AI 学成固定套路。
- **你自己打了字点推进，说话照常显示**。只有程序补的占位语才隐藏。

## 顺带修复：长局 DOM 其实还在涨

上一版（v0.3.1）给消息流做了窗口化渲染，但只覆盖了「读档/开局」这条路径。跑团进行中的消息是逐条追加的，追加时没有做裁剪——所以跑久了 DOM 还是会一路涨上去，窗口化等于只在读档那一刻有效。

现在每次追加都会从顶部裁掉超出窗口的老消息，DOM 稳定在 200 条左右，跑多久都不涨。

窗口的计数也改成按**看得见的消息**来数：隐藏的推进语不占名额，否则屏幕上实际能看到的会少于 200 条。

## 升级说明

直接下载新的 \`COC.exe\` 覆盖旧的即可，存档不受影响。

旧存档里已经存在的那些「继续推进剧情」记录不会自动消失（它们是历史数据），但**新产生的不会再显示**。
`;

writeFileSync(out, JSON.stringify({ tag_name: VERSION, name: VERSION, body }, null, 2), 'utf8');
console.log(`已生成 ${out}`);
console.log(`版本：${VERSION}`);
console.log(`正文长度：${body.length} 字符`);
