// ---------------------------------------------------------------------------
// 生成 v0.2.1 Release 的正文 JSON
//
// 沿用 v0.1.5 时的经验：用 Node 明确写 UTF-8 文件，不经过 PowerShell 的
// 编码转换，避免中文变问号。
//
// 输出：tools\ui\shots\release-body.json（UTF-8 无 BOM）
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tools', 'ui', 'shots');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'release-body.json');

const body = `## 修复

### AI 生成按钮点了没反应

游戏设定 → 编辑角色卡 → 点 **AI 生成**，按钮毫无反应（只有控制台有红字）。

根因是按钮用 \`window.prompt\` 收集创作方向，而 **Electron 渲染进程不支持 prompt**，调用即抛
\`Error: prompt() is and will not be supported.\`。更糟的是这句 prompt 写在 \`try\` 外面，
异常没人接住，界面上就表现为「点了没反应」——这个按钮在打包版里**从来没工作过**。

现在换成自建的输入弹窗（语义与 prompt 对齐：确定返回内容、取消/遮罩/Esc 返回 null），
并把整个生成流程纳入异常处理，任何环节出错都会给出看得懂的提示。

### 技能点花不完

两个独立原因：

**其一：「添加 AI 队友」完全没有补点逻辑。**
玩家填个职业、点两项擅长技能，生成的角色职业点能剩 250 点、兴趣点剩 150 点，
在团里几乎是废人。现在统一走补点流程。

**其二：3 个职业的固定本职技能太少，装不下预算。**

| 职业 | 职业点预算 | 本职技能加满 99 的空间 | 缺口 |
|---|---|---|---|
| 法医 | 396 | 340 | **56** |
| 医疗技术员 | 396 | 355 | **41** |
| 科学搜查研究员 | 396 | 266 | **130** |

按 COC 7e 原版规则补齐了 \`科学①②③\`、\`技艺①\`、\`急救\` 等本职技能与特长名额。

## 验证

- 全部 9 个测试文件通过；技能点测试从 329 项扩到 358 项
- 真实 Electron 端到端验证：
  - 确认 \`window.prompt\` 在 Electron 中确实不可用，新的输入弹窗 8 项全通过
  - 点击 AI 生成 → 弹窗 → 发请求 → 表单更新 → 保存写回，6 项全通过
  - **全 225 个职业**在 EDU/INT 拉满且 AI 一项技能都不给的极端条件下，零剩余点数

## 下载

下载下方 \`COC-Keeper-v0.2.1-win-x64-portable.exe\`（约 107 MB），双击即可运行，无需安装。

> 便携版首次启动需解压约 7.8 秒，之后走缓存约 1.4 秒。
`;

const payload = { body, name: 'v0.2.1' };
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

const readBack = JSON.parse(readFileSync(out, 'utf8'));
console.log('已写入:', out);
console.log('正文字符数:', readBack.body.length);
console.log('中文完好:', /AI 生成按钮点了没反应/.test(readBack.body));
console.log('问号污染:', readBack.body.includes('??'));
