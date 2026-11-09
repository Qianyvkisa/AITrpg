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

const body = `## 修复

### 游戏设定里的预置队友卡，兴趣点一分没花

打开「游戏设定」，队友卡那一行显示 HP / SAN / MP 都正常，看着像一张能用的卡。
点「编辑」进技能页才发现：**兴趣点 0 / 140，剩 140**，职业点也还剩一百多点。

根因在 \`createTeammate\`：它把模板点名的三项技能硬设成 60 就结束了，
**剩下的预算一分没动**，也从没调用过补点逻辑。实测 200 张队友卡：

| 项目 | 修复前 | 修复后 |
|---|---|---|
| 职业点有剩余 | **200 / 200** | 0 / 200 |
| 兴趣点没花 | **196 / 200** | 0 / 200 |
| 性别为空 | **200 / 200** | 0 / 200 |

现在队友卡生成后会走完整的点数分配：先把模板技能抬到「看得出来擅长」的水平，
再按职业把职业点和兴趣点分配干净，账目刚好归零、不超支。
模板池也补上了性别字段——之前 8 个模板一个都没有，队友卡性别全是空格子。

### 玩家默认卡是空白卡，界面却没有任何提示

玩家默认卡按设计就是空白的，等你自己点「AI 生成」或「随机」来车。
但界面原来只显示「无职业 · HP 10 SAN 50」，看起来像一张正常卡，
很容易直接开团，上桌才发现技能全是初始值。

现在空白卡会显示虚线边框 + 一行提示：
> 这张卡还没车：点「编辑」后选「AI 生成」，或直接点「随机」

默认卡本身仍然保持空白——这是刻意的产品选择，让 AI 生成成为明确入口，
而不是替玩家预先决定玩什么职业。

## 验证

- 全部 9 个测试文件通过；技能点测试从 399 项扩到 **407 项**
- 新增回归测试：
  - **60 张预置队友卡**：职业点、兴趣点全部花完，零超支，性别不为空
  - 补点后角色仍保有「擅长的技能」，模板画像没被埋掉
  - 默认玩家卡保持空白（防止以后有人好心预填）
- 端到端验证：玩家模式 / 旁观模式 / 队友人数边界（0、1、4、9、-1）全部正常

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
