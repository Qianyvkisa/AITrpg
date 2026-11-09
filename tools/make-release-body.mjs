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
const outDir = join(root, 'tools', 'ui', 'shots');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'release-body.json');

const body = `## 修复

### AI 生成的角色卡，技能点还剩一大堆

用 **AI 生成**车完卡，进角色卡编辑器一看：职业点还剩几十点、兴趣点直接爆红成负数，
怎么调都调不平。

根因是削超支那一步的实现有硬伤。AI 有时候不听「技能集中在少数几项」的劝，
给几十项技能各加几十点——兴趣点预算只有 \`智力×2\`（约 140），它能花掉 4000 以上。
旧代码是「每轮削 1 点、最多削 2000 轮」，超支超过 2000 点时循环被上限强行截断，
**剩下的两千多点超支原样留在卡上**：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 会计师 + AI 把技能全铺到 90 | 兴趣点 **-2148** | 0 |
| 会计师 + AI 把技能全铺到 99 | 兴趣点 **-5163** | 0 |

现在改成**一次性批量削**：先算出这一侧总共超支多少，直接从技能上扣掉，
不再一轮挪一点。削的顺序也从「加点最多的先削」改成「加点最少的先削」——
这样削完会留下少数几项高值技能，卡还是那个卡，而不是所有技能都被磨平。

### 信用评级堆太高就永远平不了

削超支时跳过了「不参与补点」的技能（信用评级 / 克苏鲁神话 / 自定义技能），
但算账时这些技能是照单全收的。AI 给信用评级写 99，那 99 点就实打实记在兴趣账上，
却永远削不掉——账目恒定差 58 点，玩家怎么调都差一口气。现在这类技能也会被正常削减。

## 验证

- 全部 9 个测试文件通过；技能点测试从 358 项扩到 **399 项**
- 新增回归测试：
  - **225 个职业 × 技能全铺 90/99**，共 450 组，账目全部归零（修复前这 450 组全部超支）
  - 信用评级 / 克苏鲁神话堆到 99 时仍能削平
  - 所有带「任意特长」名额的职业，AI 生成后特长**自动选满**
- 顺带修掉一个偶发失败的测试：\`randomCharacter\` 不指定职业时随机挑，
  旧断言「侦查 > 25」撞上本职不含侦查的职业就会挂（连跑 20 次会失败 1~2 次），
  现已改为指定职业后断言

## 下载

下载下方的 \`COC.exe\`，双击即可运行，无需安装。

> GitHub 的附件名只支持 ASCII，中文会被平台剥掉，所以这里只能叫 \`COC.exe\`。
> 想让它显示成「COC跑团」，下载后自行改个名即可，不影响运行。

> 便携版首次启动需解压约 7.8 秒，之后走缓存约 1.4 秒。
`;

const payload = { body, name: 'v0.2.2' };
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

const readBack = JSON.parse(readFileSync(out, 'utf8'));
console.log('已写入:', out);
console.log('正文字符数:', readBack.body.length);
console.log('中文完好:', /技能点还剩一大堆/.test(readBack.body));
console.log('问号污染:', readBack.body.includes('??'));
