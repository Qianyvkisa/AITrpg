# 项目维护指南

面向后续维护者的技术文档。用户向说明见 [README.md](README.md)，这里只讲**代码怎么组织、改哪里、怎么验证、别踩哪些坑**。

- 当前版本：`0.2.5`
- 技术栈：Electron 44 + 原生 ES Modules（无打包器、无框架）
- 仓库：https://github.com/Qianyvkisa/AITrpg

---

## 1. 一分钟理解这个项目

一个单机 COC 7th 跑团程序：**AI 同时扮演守密人（KP）和队友调查员**，本地负责掷骰与规则结算。

核心设计原则只有一条：

> **AI 只能"请求检定"，不能自己出结果。所有骰点由本地引擎掷。**

这条原则贯穿全项目。AI 在叙述里写 `[[CHECK:侦查]]`，本地解析成待掷骰的检定，玩家掷完再把结果回喂给 AI，AI 才知道成败。这样做是因为让 LLM 自己编骰点会稳定地编出"每次都成功"的故事，跑团就没意义了。

理解这一点，就能理解为什么 `protocol.js`（解析指令）、`directives.js`（结算指令）、`engine.js`（编排回合）是整个项目的骨架。

---

## 2. 目录结构

```
D:\Tool\AIrpg\
├── main.js                 主进程入口，只做装配（约 90 行，别往里加业务逻辑）
├── preload.js              contextBridge 暴露 window.api（渲染层唯一的 IPC 出口）
├── package.json            版本号 + 构建配置（build 字段）
├── release.ps1             一键发布：测试 → 打包 → 提交 → 推送
├── start.ps1               开发模式启动（用 .udata 作数据目录）
│
├── electron/               主进程模块（Node 环境，CommonJS）
│   ├── window.js           窗口生命周期、splash、规则书独立窗口
│   ├── config.js           配置读写（baseUrl / apiKey / model ...）
│   ├── llm.js              LLM 请求 + 流式解析 + 重试循环
│   ├── retry.js            重试策略（纯逻辑，可测）
│   ├── sse.js              SSE 增量解码器
│   ├── storage.js          userData/data 下的 JSON 读写
│   ├── ipc-files.js        存档 / 模组 / 角色卡 / 规则书 的 IPC
│   ├── materials.js        模组文件解析（txt / docx / pdf / 图片）
│   ├── moduleAI.js         模组内容 AI 分析（提取场景、NPC、线索）
│   └── crashlog.js         崩溃日志（coc-keeper-crash.log）
│
├── src/                    渲染层（浏览器环境，原生 ESM）
│   ├── app.js              界面装配与事件绑定（约 710 行，最杂的一个文件）
│   ├── state.js            全局状态定义（唯一状态容器）
│   ├── persistence.js      状态 ↔ 存档 JSON 的双向转换
│   ├── index.html          主界面骨架
│   ├── styles.css          全部样式（约 1786 行，无预处理器）
│   │
│   ├── core/               ★ 纯逻辑，不碰 DOM，全部可被 node 直接测试
│   │   ├── protocol.js     AI 指令解析 + 文本切分（splitNarration）
│   │   ├── directives.js   指令结算处理器（CHECK/SAN/DAMAGE/...）
│   │   ├── engine.js       GameEngine：回合编排、流式、待掷骰
│   │   ├── character.js    角色卡数据结构与派生值
│   │   ├── occupations.js  职业表与技能点计算
│   │   ├── dice.js         骰点与成功等级
│   │   ├── sanity.js       理智检定、疯狂、恐惧症
│   │   ├── prompts.js      系统提示词
│   │   ├── session.js      建局（模式、队友数量）
│   │   ├── autoAdvance.js      自动推进的判定逻辑
│   │   └── autoAdvanceRunner.js 自动推进的调度器（定时器可注入）
│   │
│   ├── modals/             各弹窗（设定、角色卡编辑、模组、存档、设置）
│   ├── services/           charGen（AI 车卡）、teammate（队友对话/行动）
│   ├── ui/                 消息渲染、侧栏面板、菜单
│   └── vendor/             第三方 PDF 资源（pdfjs + cmaps + 字体，勿改）
│
├── tests/                  16 个测试文件，全部 node 直跑，无测试框架
├── tools/                  构建、验证、发布、排查脚本
├── build/portable.nsi      自定义便携版启动器模板
└── assets/                 图标；规则书 PDF 不入库（版权原因）
```

### 分层规矩

| 层 | 可以依赖 | 禁止 |
|---|---|---|
| `src/core/*` | 只依赖 `src/core/*` 和 `src/state.js` | **禁止 import DOM、`window`、`document`** |
| `src/ui/*`、`src/modals/*` | core、state、`window.api` | 禁止直接写业务规则 |
| `electron/*` | Node、Electron API | 禁止依赖 `src/`（主进程与渲染层只能走 IPC） |

`core/` 的纯净性是整个测试体系的地基——正因为它们不碰 DOM，`tests/` 才能用 `node` 直接跑，不需要 jsdom。

---

## 3. 数据流：一次"推进"发生了什么

这是最重要的流程图，改任何功能前先对一遍：

```
玩家点「推进」/ 自动推进定时器到点
        ↓
app.js  spectatorAdvance()  或  sendAction()
        ↓
engine.takeTurn(text)
        ↓
engine.playerAction()  →  pushMessage({role:'user'})
        ↓
engine.runKeeper()
        ↓
buildKeeperMessages()  ←  prompts.keeperSystemPrompt() + 历史 + 角色卡 + 模组信息
        ↓
api.chat({ messages, purpose:'keeper', requestId, stream:true })
        ↓  ── IPC ──→  electron/llm.js
        │              resolveTarget() 选端点/密钥/模型
        │              fetch + SSE 流式
        │              失败则 retry.js 判定是否重试
        │              ←── llm:chunk 事件逐块回推
        ↓
onChunk 回调 → msg.text += delta → emit('stream-chunk') → 界面增量渲染
        ↓
请求结束，msg.streaming = false
        ↓
【关键】parseDirectives(msg.text)
        ↓
resolveDirectives()  →  directives.js 的 define() 处理器
        │                  CHECK → 生成 pendingRoll（等玩家掷）
        │                  SAN   → 立即掷理智
        │                  DAMAGE/HP/ITEM/FLAG/SCENE/END → 直接结算
        ↓
若产生待掷骰：emit('state-changed')，界面亮起掷骰按钮，回合到此暂停
        ↓
玩家掷骰 → rollAndResume() → feedBackResults() → 再跑一轮 runKeeper()
        ↓
若返回 false（连接失败）：不写 turns、不关自动推进开关，只暂停
```

### 两个容易搞错的点

1. **`turns` 只在成功时累加**（`app.js` 的 `spectatorAdvance`）。失败时不能加，否则轮数虚增、自动推进会拿着"成功"信号继续空转。
2. **`runKeeper()` 返回 `false` 表示这一轮其实没跑成**。这个信号被自动推进依赖，改动时别弄丢。

---

## 4. AI 指令协议（最常改的地方）

AI 在叙述文本里嵌 `[[TYPE:内容|选项]]`，本地解析并结算。

### 支持的指令

| 指令 | 用途 | 结算方式 |
|---|---|---|
| `CHECK` | 技能检定 | 生成 pendingRoll，**等玩家掷** |
| `SAN` | 理智检定 | 立即掷，可能触发疯狂 |
| `DAMAGE` | 扣血 | 直接结算 |
| `HP` | HP 增减 | 直接结算 |
| `ITEM` | 物品获得/失去 | 直接结算 |
| `FLAG` / `CLUE` | 记录线索 | 写入 scenario.clues |
| `SCENE` | 场景切换 | 写入 scenario.scene |
| `END` | 剧情结束 | 置 scenario.ended |

### 新增一个指令类型

三处都要动，缺一个就静默失效：

1. **`src/core/protocol.js`** — 若需特殊解析（参考 `FLAG` 的键值拆分）
2. **`src/core/directives.js`** — `define('NEWTYPE', (ctx, d) => {...})`
3. **`src/core/prompts.js`** — 在 `keeperSystemPrompt()` 里告诉 AI 有这个指令（**最容易漏**，AI 不知道就不会用）

然后加测试到 `tests/rules.test.mjs`。

### 文本切分

`splitNarration(text)` 把 KP 回复切成「旁白 / NPC 台词」片段，界面按片段拆气泡。它同时负责**剥掉 `[[...]]` 指令**——玩家不该看到原始指令文本。改渲染前先看这个函数。

---

## 5. 状态与存档

### 唯一状态容器

`src/state.js` 的 `createInitialState()` 定义全部字段。加字段就在这里加，并在 `persistence.js` 决定是否持久化。

### 存档规则

- 位置：`app.getPath('userData')/data/`（开发模式是项目下 `.udata/`）
- 格式：`{ meta:{...}, state:{...} }`，`applySnapshot()` 兼容老存档的裸 state 格式
- **新字段必须给旧存档兜底**，否则老存档读进来是 `undefined`：

```js
state.teammateAutonomous = s.teammateAutonomous !== false;  // 缺字段时默认 true
state.companions = Array.isArray(s.companions) ? s.companions : [];  // 缺字段时默认 []
```

### 故意不持久化的字段

`autoAdvance` / `autoAdvanceDelay` / `autoAdvanceRun` 不存档——读档后自动推进从关闭状态开始，避免"读档后程序自己动起来"。

---

## 6. 自动推进（v0.2.5 刚改过，注意语义）

分成两个文件，职责严格分开：

- **`autoAdvance.js`** — 纯判定：`autoAdvanceBlocker()` 返回阻止原因（`null` 表示可推进）
- **`autoAdvanceRunner.js`** — 调度：定时器、开关、恢复，依赖全部注入（可注入假定时器测试）

### 阻止原因的两种性质（核心区分）

| 原因 | 性质 | 开关 | 恢复方式 |
|---|---|---|---|
| `ended` | **终局** | 关闭 | 只能开新局 |
| `pending-roll` | 暂时 | 保持开启 | 掷完骰自动接上 |
| `busy` | 暂时 | 保持开启 | 本轮跑完自动接上 |
| `max-turns` | 暂时 | 保持开启 | **手动推一次即清零计数** |

**`max-turns` 曾经是终局，那是个 bug**：撞到上限后 `toggle()` 直接拒绝开启，玩家永久卡死只能重开游戏。现在归到"暂时"，`resetRunCount()` 会清零。

### 轮数上限算的是什么

算 **`state.autoAdvanceRun`（连续自动推进轮数）**，不是 `state.turns`（整局轮数）。

用整局轮数当上限会误伤正常长局——2 秒间隔下 200 轮只要 7 分钟。现在上限 1000，且玩家任何手动操作都清零。

### 唯一的调度入口

`resume()` 是幂等的（开关关着/定时器已在跑/有 blocker 都直接返回）。**所有路径都要收敛到它**：手动推进后、自动推进跑完后、掷完骰后。

这里踩过大坑：手动推进时 `cancel()` 清掉了定时器，但跑完没人重建，于是开关亮着、按钮显示「自动推进 · 开」，却一动不动。改这块务必跑 `tests/autoAdvanceRunner.test.mjs`。

### 故障恢复：502 不该让玩家手动点（v0.2.6 修）

自动推进遇到 API 故障时，**不能一律停下等玩家**——否则功能就退化成「每次抖动都要我手点一下」。按故障性质分流：

| 故障 | 处理 | 理由 |
|---|---|---|
| 502/503/504/429/408、网络断开、超时 | **退避后自动重试**（5s→10s→20s，最多 3 次） | 上游抖一下，等几秒自己就好 |
| 401/403/404/400、缺 Key、缺模型名 | **立刻暂停**并说明要改哪里 | 配置错了，重试一百次也一样，只会让玩家多等 |
| 未知错误 | 暂停 | 宁可让玩家看到，也别无声反复重试 |

判定函数是 `isRecoverableFailure(text)`（`core/autoAdvance.js`），按**文案关键词**匹配——因为渲染层拿到的是已翻译的 `friendly` 字符串，拿不到原始 HTTP status。关键词与 `electron/retry.js` 的 `describeFailure()` 保持对应，**改文案时两边要一起改**。

> **接线陷阱（本次 bug 的真正位置）**
>
> `spectatorAdvance()` 的 `finally` 里有 `resumeAutoAdvanceIfNeeded()`。失败分支 `return` 之后它**仍会执行**，于是：
> - 可恢复故障：把 `recoverAfterFailure` 排好的 5 秒退避覆盖成 2 秒正常间隔
> - 配置错误：定时器已被取消，`resume()` 又按 2 秒重排 → **「暂停」变成无限重试**
>
> 修法是加 `failed` 标志，`finally` 里只在 `!failed` 时 resume。`tests/autoRecover.flow.test.mjs` 专门守这个接线，且已做变异验证（去掉 `failed` 守卫会立刻红 2 项）。

### 两个失败计数，别搞混

| 计数 | 字段 | 用途 | 清零时机 |
|---|---|---|---|
| 连续自动推进轮数 | `state.autoAdvanceRun` | 防失控空转（上限 1000） | 玩家任何手动操作 |
| 连续失败次数 | runner 内部 `failureCount` | 退避与重试上限（3 次） | 一轮成功 / 重试耗尽 |

---

## 7. LLM 调用与错误处理

### 请求链路

`engine.api.chat()` → IPC `llm:chat` → `electron/llm.js` 的 `chat()`

`chat()` 里做了三件事：解析目标端点、重试循环、把错误翻译成人话。

### 重试策略（`electron/retry.js`）

| 错误 | 是否重试 | 理由 |
|---|---|---|
| 502/503/504/500/408/429 | 是（2 次，退避 0.8s→1.6s + 抖动） | 上游瞬时故障，等一会儿就好 |
| ECONNRESET / ETIMEDOUT / fetch failed | 是 | 网络抖动 |
| 401/403/404/400 | **否** | 配置错了，重试只是让玩家多等三倍时间 |
| `canceled: true` | **否** | 玩家点了取消 |

### 流式输出的硬约束

**已经推出 chunk 之后中断，不能重试。** 否则重试会把前半段重复推一遍，界面上出现两截拼接的乱码。`attemptOnce()` 用 `pushed` 标记判断，中断时返回 `canceled: true` 让上层当作取消处理。

### 错误文案

`describeFailure()` 把上游错误翻译成中文说明。**别把 `res.error` 直接显示给玩家**——那里面是整页 HTML。用 `res.friendly`。

链路：`llm.js` 设 `friendly` → `engine.runKeeper()` 存进 `this.lastError` → `takeTurn()` 放进返回值的 `error` 字段 → `app.js` 读取。

### 取消机制

`inflight` Map（requestId → AbortController）管进行中的连接，`canceled` Set 记取消标记。**两个都要**：`inflight` 在每次尝试结束时清空，单靠它无法区分"刚跑完"和"被取消"，重试循环会误判。

---

## 8. 测试

### 运行

```powershell
# 全部（16 个文件）
npm test

# 单个
node tests/autoAdvanceRunner.test.mjs
```

没有测试框架，每个文件自己维护 `ok()` / `eq()` 计数，末尾打印通过数与失败项。断言失败时 `process.exitCode = 1`。

### 文件清单

| 文件 | 覆盖 |
|---|---|
| `unit.test.mjs` | 最大的一份（1467 行），跨模块综合 |
| `rules.test.mjs` | 指令解析与结算 |
| `occupations.test.mjs` | 职业表与技能点 |
| `charGen.points.test.mjs` | AI 车卡的点数分配（历史上 bug 最多的地方） |
| `charStore.test.mjs` | 角色卡存取与容错 |
| `charEditor.smoke.mjs` | 角色卡编辑器（DOM 桩） |
| `gameSetup.smoke.mjs` | 建局流程（DOM 桩） |
| `messages.dom.test.mjs` | 消息渲染（DOM 桩） |
| `ruleBook.test.mjs` | 规则书索引 |
| `teammateAct.test.mjs` | 队友自主行动 |
| `retry.test.mjs` | 重试分类与退避（纯逻辑） |
| `llmRetry.test.mjs` | `chat()` 真实重试循环（假 fetch） |
| `errorFlow.test.mjs` | 502 → engine → 界面文案的端到端链路 |
| `autoAdvance.test.mjs` | 自动推进判定逻辑 + 故障分类 + 退避 |
| `autoAdvanceRunner.test.mjs` | 自动推进调度（假定时器）+ 失败恢复 |
| `autoRecover.flow.test.mjs` | 502/401 端到端：退避不被 finally 覆盖 |
| `autoAdvance.dom.test.mjs` | 自动推进按钮外观（DOM 桩） |

### DOM 桩怎么写

`tests/` 里没有 jsdom。`charEditor.smoke.mjs` 等文件自己搭了个极简 `El` 类模拟 `querySelector` / `classList` / `addEventListener`。

**代价**：这些测试会**照抄**被测函数的一部分逻辑。抄件永远跟着测试一起改，真实代码改坏了测试照样绿——这正是"自动推进没效果"的 bug 能活到用户手里的原因。

**所以**：核心逻辑尽量放 `src/core/`（能 import 真实代码），别留在 `app.js`。`autoAdvanceRunner.js` 就是从 `app.js` 抽出来的，注释里写了原因。

### 主进程模块的测试技巧

`electron/*.js` 是 CommonJS 且 `require('electron')`，node 里跑不了。`tests/llmRetry.test.mjs` 用 `Module._load` 拦截：

```js
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') return { ipcMain: { handle() {}, on() {} } };
  return origLoad.call(this, request, ...args);
};
```

配置也一起挡掉（`require.cache[configPath] = {...}`），避免读真实磁盘配置。

---

## 9. 构建与发布

### 一键发布（推荐）

```powershell
.\release.ps1                      # 提交信息自动按改动生成
.\release.ps1 -Message "修复存档"
.\release.ps1 -SkipTest            # 跳过测试（不推荐）
.\release.ps1 -NoPush              # 只提交不推送
```

脚本会依次：跑测试 → 校验版本一致性 → patch NSIS → 打包 → 移动产物 → 提交 → 推送。任何一步失败立即停。

### 手工发布步骤

```powershell
# 0. 全局设置（本机代理证书问题，见下面「三个坑」）
$env:NODE_OPTIONS = '--use-system-ca'
$node = 'C:\Users\junyu\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 1. 改版本号（package.json 的 version）
# 2. 编辑 tools/make-release-body.mjs 里的发布说明文案，然后生成正文
& $node tools\make-release-body.mjs
#    → 输出 tools\ui\shots\release-body.json（该目录被 gitignore，不入库）

# 3. 打 NSIS 补丁（覆盖 electron-builder 的 portable 模板）
& $node tools\patch-portable-nsi.mjs

# 4. 打包
& $node node_modules\electron-builder\out\cli\cli.js --win portable

# 5. 移动产物到根目录（需要先关掉正在运行的 exe）
& $node tools\move-artifact.mjs

# 6. 提交并推送代码
git add -A; git commit -m "..."; git push origin HEAD

# 7. 创建 Release 并上传（需要 GH_TOKEN）
$env:GH_TOKEN = (& powershell -NoProfile -ExecutionPolicy Bypass -File tools\get-gh-token.ps1).Trim()
& $node tools\publish-release.mjs
```

> 注意第 2 步的产物路径：`tools/ui/shots/` 整个目录在 `.gitignore` 里（只保留脚本、不保留产物）。这意味着**发布正文不会被提交**，每次发布前都要重新生成——这是有意的，避免仓库里堆历史发布稿。

### 本机环境的三个坑

1. **证书验证失败**：本机代理有中间人证书，`electron-builder` 和 `publish-release.mjs` 都会报 `unable to verify the first certificate`。**必须加 `--use-system-ca`**。`release.ps1` 里已通过 `NODE_OPTIONS` 设置好了。
2. **没有全局 npm / pnpm**：只有 `node.exe`（路径见 `release.ps1` L32）。用 `node node_modules\electron-builder\out\cli\cli.js` 直接调用，别指望 `npm run`。注意实际入口是 `out\cli\cli.js`，不是 `cli.js`。
3. **exe 正在运行挡住覆盖**：`move-artifact.mjs` 会报错。先 `Get-Process COC跑团 | Stop-Process -Force`。

### GitHub Release 附件名限制

平台**只接受 ASCII 附件名**，中文会被静默剥掉（`COC跑团.exe` → `COC.exe`）。`publish-release.mjs` 里显式处理了这一点，本地名与上传名分开。

### 启动器缓存指纹

便携版启动器会把程序解压到 `%LOCALAPPDATA%\coc-keeper-ai-app`，二次启动直接跑缓存（实测 5500ms → 157ms）。

**缓存失效靠内容指纹，不是版本号**。`patch-portable-nsi.mjs` 对「会被打进 exe 的所有源码 + 版本号」算 SHA，嵌进 `portable.nsi` 的 `@@CACHE_STAMP@@`。

为什么不能只用版本号：改了代码但忘升版本时，用户机器上会一直跑旧代码，而且**完全无感**。这比启动慢严重得多。

验证：
```powershell
node tools/verify-startup.mjs      # 首次 vs 二次启动耗时
node tools/verify-cache-stamp.mjs  # 指纹是否随源码变化
```

---

## 10. 常见改动指引

### 加一个界面功能

1. `src/index.html` 加骨架
2. `src/styles.css` 加样式（注意 `[hidden] { display:none !important }` 在最上面）
3. `src/app.js` 绑定事件（`bindUI()` 里）
4. 状态字段加到 `src/state.js`，需要存档就改 `src/persistence.js`

### 改提示词

只改 `src/core/prompts.js`。四个函数：`keeperSystemPrompt`（KP）、`teammateSystemPrompt`（队友人设）、`teammateActionPrompt`（队友行动决策）、`moduleAnalysisPrompt`（模组分析）。

改完建议手动跑一局看看，提示词的问题测试测不出来。

### 加一个职业

`src/core/occupations.js` 的 `OCCUPATIONS` 数组。注意 `skills` 里写的是职业点公式（如 `"侦查": 60` 或 `"教育×2"`），格式错会让车卡算出负剩余点。

`tests/occupations.test.mjs` 和 `tests/charGen.points.test.mjs` 会验证。

### 排查"AI 输出乱码 / 界面卡住"

1. 看 `electron/coc-keeper-crash.log`
2. 用 `node tools/probe-chargen.mjs` 单独调一次 LLM 看原始返回
3. 检查 `splitNarration()` 是否正确剥掉了未闭合的 `[[`（它有专门处理尾巴的逻辑）

### 排查启动问题

`README.md` 的「打包与启动速度」一节有完整的踩坑记录（splash 闪一下就没、指纹为什么不能只用版本号等），比这里详细。

---

## 11. 已知限制与技术债

按优先级排，供后续规划参考：

| 项 | 说明 | 影响 |
|---|---|---|
| `app.js` 710 行 | 界面装配、事件绑定、业务胶水全在一起 | 改动容易牵一发动全身；核心逻辑应继续往 `core/` 抽 |
| `styles.css` 1786 行 | 无预处理器、无 CSS 变量分层 | 改主题色要全文搜索 |
| DOM 测试照抄实现 | `charEditor.smoke` 等文件复制了部分真实逻辑 | 真实代码改坏时测试可能仍然绿 |
| 流式中断不可重试 | 已推出 chunk 后中断只能失败 | 长回复被打断时玩家需手动重试 |
| 队友每个多一次 API 调用 | `teammateAutonomous` 开启时 | 一轮可能 3+ 次请求，token 消耗大 |
| 规则书 PDF 不入库 | 版权原因 | 新环境需自己放 `assets/coc-kp.pdf` |
| `src/vendor/` 28MB+ | pdfjs + cmaps + 字体 | 勿改；升级 pdfjs 时要连带更新 cmaps |

---

## 12. 提交前检查清单

- [ ] `npm test` 全绿（16 个文件）
- [ ] 改版本号时，`package.json`、`make-release-body.mjs`、提交信息三处一致（`release.ps1` 会交叉校验）
- [ ] 新加的 `state` 字段在 `applySnapshot()` 里有兜底
- [ ] 新加的指令类型三处都改了（protocol / directives / prompts）
- [ ] 错误提示用 `res.friendly`，不要把 `res.error` 直接甩给玩家
- [ ] 动过自动推进的话，`autoAdvanceRunner.test.mjs` 必须过
- [ ] 不提交 `dist/`、`*.exe`、`.udata/`、`assets/*.pdf`

---

## 附：关键常量速查

| 常量 | 位置 | 值 | 含义 |
|---|---|---|---|
| `AUTO_ADVANCE_MAX_TURNS` | `core/autoAdvance.js` | 1000 | 连续自动推进上限 |
| `AUTO_RECOVER_MAX` | `core/autoAdvance.js` | 3 | 可恢复故障的重试上限 |
| `recoveryDelay(1..n)` | `core/autoAdvance.js` | 5s→10s→20s（封顶 30s） | 重试退避 |
| `DEFAULT_DELAY` | `core/autoAdvance.js` | 2000 | 自动推进间隔（ms） |
| `MIN_DELAY` / `MAX_DELAY` | `core/autoAdvance.js` | 500 / 60000 | 间隔允许范围 |
| `DEFAULT_MAX_RETRIES` | `electron/retry.js` | 2 | 重试次数（共 3 次请求） |
| `DEFAULT_BASE_DELAY` | `electron/retry.js` | 800 | 首次重试等待（ms） |
| `MAX_BACKOFF` | `electron/retry.js` | 8000 | 退避上限（ms） |
| `MAX_TEAMMATES` | `core/session.js` | 4 | 队友数量上限（可选 0–4） |
| `MAX_CHAIN` | `core/engine.js` | 3 | 单回合内检定回喂的最大链数 |
