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

const body = `## 修复：框选文字时弹窗自己关掉

在设置界面里按住鼠标拖选 API 地址、密钥、模型名，手一滑移出弹窗、在旁边的空白处松开——弹窗就自己关掉了，刚填的内容也一起没了。角色卡、存档、模组这些弹窗都有同样的问题。

### 为什么会这样

原来的判断是「点到了遮罩空白处就关闭」，用的是浏览器的 \`click\` 事件。而 \`click\` 有个容易被忽略的规则：**它的触发目标是「按下位置」和「松开位置」的最近共同祖先**。

于是框选拖出去的时候：

\`\`\`
按下 → 在弹窗内（输入框里）
松开 → 在遮罩空白处
click 的目标 = 两者的共同祖先 = 遮罩本身
\`\`\`

看起来就跟「点了空白处」一模一样，弹窗被关掉。这跟「点空白关闭」这个功能本身无关，纯粹是判据用错了。

### 现在怎么判断

改成「按下和松开**都**落在遮罩空白处」才算真的点了空白：

| 操作 | 旧行为 | 新行为 |
|---|---|---|
| 弹窗内按下 → 拖到遮罩上松开（框选拖出去） | 弹窗关闭 ❌ | **不关闭** ✅ |
| 遮罩上按下 → 拖回弹窗内松开（改主意了） | 弹窗关闭 ❌ | **不关闭** ✅ |
| 遮罩上按下 → 遮罩上松开（真的点空白） | 关闭 | 关闭 ✅ |
| 点 × / 点「取消」 | 关闭 | 关闭 ✅ |

另外补了一处：鼠标拖到窗口外面再松开时，浏览器不会派发松开事件，会留下一个「按下状态」残值。下次再在空白处松开可能凑成一次假点击，所以鼠标移出弹窗区域时会主动清掉这个状态。

影响范围是所有弹窗——设置、角色卡、角色库、存档、模组、队友创建、输入框提示，都走同一套容器逻辑。

## 升级说明

直接下载新的 \`COC.exe\` 覆盖旧的即可，存档不受影响。
`;

writeFileSync(out, JSON.stringify({ tag_name: VERSION, name: VERSION, body }, null, 2), 'utf8');
console.log(`已生成 ${out}`);
console.log(`版本：${VERSION}`);
console.log(`正文长度：${body.length} 字符`);
