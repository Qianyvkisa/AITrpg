// ---------------------------------------------------------------------------
// 生成 v0.2.2 Release 的正文 JSON
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

const body = `## 新功能

### 旁观模式：自动推进

旁观模式本来每轮都要手动点「推进」，一局跑下来点上百次，纯属机械劳动。
现在输入区多了一个「自动推进」按钮，打开后每轮 KP 叙述完自动继续，
不用再手动点。按钮会在开启时变成黄铜色呼吸状态，一眼能看出它正在自己跑。

它会**自己在该停的时候停**：

| 情况 | 行为 |
|---|---|
| 剧情结束（KP 发出结束指令） | 停止，并提示「剧情已结束」 |
| 出现待掷骰的检定 | **暂停**（不关闭），你掷完骰自动继续 |
| KP 连接失败 | 立刻停止，提示检查模型配置 |
| 连续推进 200 轮 | 停止，防止模型陷入空转烧 token |
| 回主界面 / 读档 / 开新局 | 停止，不会在后台偷偷发请求 |

「有待掷骰」选择暂停而不是关闭，是因为骰子掷完后自动接上才符合直觉——
关掉的话你掷完还得再手动点一次开关。

## 顺带修掉的潜在 bug

### 旁观模式的轮数一直是空白

右上角的「第 N 轮」原来只数玩家消息条数。旁观模式没有玩家消息，
所以跑几十轮下来那里始终是空的。现在改为取「玩家消息数」与「显式轮数」
的较大值，两种模式都能正确显示。

### KP 连不上时会一路空转

这是给自动推进排查时发现的：模型请求失败时，引擎只把错误写进消息，
**却照常返回成功**。界面据此给轮数 +1，自动推进也认为「这一轮跑成了」
继续往下推——模型挂了就会连续发 200 次失败请求。

现在引擎会如实返回成败，界面据此判断：失败不计轮数，自动推进立刻停止。

## 验证

- 全部 **11 个测试文件**通过，共 585 + 66 + 21 项断言
- 新增两个测试文件：
  - \`autoAdvance.test.mjs\`（66 项）：推进条件的所有边界——
    剧情结束、待掷骰、请求进行中、轮数上限、玩家模式、非法参数
  - \`autoAdvance.dom.test.mjs\`（21 项）：按钮在两种模式下的显隐、
    文案、高亮状态、模式来回切换
- 端到端模拟：
  - 正常推进 → 第 5 轮剧情结束后正确停下
  - API 持续失败 → **只调用 1 次就停**（修复前会空转 200 次）

## 下载

下载下方的 \`COC.exe\`，双击即可运行，无需安装。

> GitHub 的附件名只支持 ASCII，中文会被平台剥掉，所以这里只能叫 \`COC.exe\`。
> 想让它显示成「COC跑团」，下载后自行改个名即可，不影响运行。

> 便携版首次启动需解压约 7.8 秒，之后走缓存约 1.4 秒。
`;

const payload = { body, name: VERSION };
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

const readBack = JSON.parse(readFileSync(out, 'utf8'));
console.log('已写入:', out);
console.log('正文字符数:', readBack.body.length);
// 编码自检：直接数中文字符和问号，别再拿某个固定标题当探针
// （上一版写死「技能点还剩一大堆」，标题一改就误报 false）。
const cjk = (readBack.body.match(/[\u4e00-\u9fa5]/g) || []).length;
console.log('中文完好:', cjk > 100, `（${cjk} 个汉字）`);
console.log('问号污染:', readBack.body.includes('??'));
