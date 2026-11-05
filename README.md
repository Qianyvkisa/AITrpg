# COC 跑团 · AI 守密人

一个桌面版《克苏鲁的呼唤》第 7 版跑团工具。AI 同时担任**守密人（KP）**和你队伍里的**队友调查员**。

## 直接运行

双击 `dist\COC跑团 0.1.0.exe` 即可。

这个 exe 是便携版：不需要安装，不需要 Node 环境，不依赖项目里的任何其他文件，复制到任意目录都能运行。首次启动会在临时目录里自解压，大约需要 10~20 秒，之后启动更快。

## 开发时运行

改完代码想立刻看效果，用：

```powershell
.\start.ps1
```

`start.ps1` 会先摘掉 `ELECTRON_RUN_AS_NODE` 环境变量（它会让 Electron 退化成纯 Node 解释器，表现为双击没反应），再用 `dist\win-unpacked` 里的 Electron 运行时加载**当前源码目录**，所以改动立即生效，不需要重新打包。

> `dist\win-unpacked` 必须保留：`start.ps1` 用它当运行时，重新打包也会更新它。
> `node_modules` 里那份 Electron 带 Low 完整性标签，写不了数据目录，无法用来启动。

改了代码之后要更新 exe，运行 `pnpm dist` 重新打包。

## 界面结构

程序分两层界面。

### 主界面（开始界面）

启动后首先看到的是主界面，上面有这些按钮：

| 按钮 | 作用 |
|------|------|
| **开始** | 开启一段全新的调查（若已有进度会先确认是否覆盖） |
| **继续** | 接着上次的进度跑（**只有真正跑过至少一轮之后才会出现**） |
| 存档 | 查看 / 读取 / 删除 / 手动保存存档 |
| 模组管理 | 导入或粘贴模组，选用当前模组 |
| 设置 | 配置 AI 接口、叙事基调 |

底部显示当前使用的模型；没配模型或没配 Key 时用红字提示。

> 「继续」的判断标准是**玩家至少行动过一次**。只看到开场白、还没输入任何行动，不算跑过一次团，因此不会出现「继续」。

### 跑团界面

点 **开始** 或 **继续** 后进入。左上角有 **‹ 主界面** 按钮，随时可以退回主界面（守密人正在叙述时会提示稍等）。

跑团界面里也保留了 **模组 / 存档 / 设置** 三个入口，不用退回主界面就能改配置。

## 第一次使用

1. 在主界面点 **设置**，填 AI 接口：

   | 项目 | 说明 |
   |------|------|
   | API 地址 | `https://api.deepseek.com/v1` |
   | API Key | 你的 DeepSeek 密钥（`sk-...`） |
   | 模型名 | `deepseek-chat` |

   点 **测试连接** 确认通了，再点 **保存**。

   也支持任意 OpenAI 兼容接口，比如本地 Ollama：地址填 `http://localhost:11434/v1`，Key 留空，模型填 `qwen2.5:14b`。

2. 回到主界面点 **开始**，进入跑团界面。

3. 左侧 **调查员 +** 建角色卡，点卡片可以改属性和技能。

4. **队友 +** 添加 AI 队友。**性格设定写得越具体，AI 演得越像真人**，比如：
   > 话少，抽烟，遇到血会下意识检查伤口。表面冷漠但护着队友。

5. 中间输入框写你的行动，回车发送。

## 模组

在主界面点 **模组管理**（跑团界面点右上角 **模组**，两者是同一个弹窗）：

- **从文件导入**：支持 `.txt` / `.md` / `.json`
- **手动粘贴**：把剧情大纲、线索、NPC 设定贴进去
- 不选模组也没关系，KP 会现场创作一个短篇调查故事

模组内容只有 AI 知道，它不会直接念给你听，而是拆成线索一点点透露。

## 核心机制

**所有骰子都在本地掷，AI 无法编造结果。**

AI 想让人检定时，只能输出一条指令：

```
[[CHECK: 侦查 | 角色=林默 | 难度=常规 | 原因=留意书架]]
```

本地规则引擎掷完骰、算出成功等级后，再把真实结果交回给 AI 让它描述后果。这样保证了：
- AI 不会"我掷出了 1，你大成功了"这种自说自话
- 成功率真的按你的技能值算
- SAN 损失真的会扣到角色卡上

支持的指令：

| 指令 | 作用 |
|------|------|
| `CHECK` | 技能检定（常规/困难/极难） |
| `SAN` | 理智检定，如 `1/1d6` |
| `DAMAGE` | 伤害，支持 `1d6+db` |
| `HP` / `MP` | 直接增减 |
| `ITEM` | 获得/失去物品 |
| `FLAG` / `CLUE` | 记录线索 |
| `SCENE` | 切换场景 |
| `END` | 模组结束 |

## 已实现的规则

- 骰子：d100、奖励骰/惩罚骰（单位骰掷一次，十位骰掷多次取最优/最劣）
- 成功等级：大成功(01) / 极难(≤1/5) / 困难(≤1/2) / 常规(≤技能) / 失败 / 大失败(≥96，技能<50 时仅 100)
- 角色卡：9 项属性、派生 HP/MP/SAN、伤害加值、体格、MOV、49 项技能
- 理智：SAN 检定、单次损失≥5 触发临时疯狂 + INT 检定、单次损失达当前 SAN 的 1/5 构成不定时疯狂、SAN≤20 濒临疯狂、SAN=0 永久疯狂
- 战斗：伤害掷骰含 db、重伤判定（单次伤害≥HP上限一半）、濒死

## 存档

每轮自动存档，也可以点 **存档** 手动保存多份。主界面的 **存档** 与跑团界面右上角的 **存档** 是同一个弹窗。

## 目录结构

```
main.js                主进程入口：只装配模块，不含业务逻辑
preload.js             安全桥接（contextIsolation），暴露 window.api
electron/              主进程模块
  crashlog.js          崩溃日志（多路径回落）
  storage.js           userData/data 下的 JSON 读写
  defaults.js          配置默认值与端点解析（纯逻辑，可单测）
  config.js            配置读写 IPC
  sse.js               SSE 增量解析（纯逻辑，可单测）
  llm.js               LLM 请求、流式推送、请求取消
  moduleAI.js          把导入的模组材料整理成「公开简介 + 内部真相」
  materials.js         模组材料解析（txt/md/docx/pdf/图片）
  ipc-files.js         存档 / 模组 / 通用存储 IPC
  window.js            窗口创建与生命周期
src/
  index.html           界面骨架（主界面 + 跑团界面）
  styles.css           样式
  app.js               应用装配：界面切换、连引擎、绑界面、接弹窗
  state.js             全局状态容器与默认角色
  persistence.js       存档快照 ↔ 状态
  shared/text.js       HTML 转义、指令剥离
  services/
    teammate.js        队友 AI 单次调用
    charGen.js         随机车卡 / AI 车卡
  ui/
    menu.js            主界面菜单
    panels.js          侧栏面板渲染（角色/队友/状态/线索/日志）
    messages.js        消息流渲染与流式气泡
  modals/              弹窗
    shell.js           通用弹窗容器
    index.js           统一出口
    settings.js        设置
    modules.js         模组管理
    gameSetup.js       开局设定（模组选择 + 参与方式 + 角色卡 + 公开简介）
    charEditor.js      角色编辑
    teammateCreator.js 队友创建
    modelPicker.js     模型选择
    saves.js           存档
  core/                规则内核（与界面无关，可单测）
    dice.js            骰子、奖励/惩罚骰、成功等级
    character.js       角色卡与派生值
    sanity.js          理智系统
    protocol.js        AI 指令解析
    directives.js      各指令的结算处理器（注册表）
    prompts.js         KP 与队友提示词
    engine.js          游戏主循环（只做流程编排）
    session.js         从设定界面组装开局状态
    moduleInfo.js      模组公开简介的结构与校验
    builtinModules.js  内置示例模组
tests/
  rules.test.mjs       规则引擎单元测试（138 项）
  unit.test.mjs        协议/指令/存档/SSE 单元测试（476 项）
  charEditor.smoke.mjs 角色编辑器与设定界面冒烟测试（41 项）
tools/
  dev-server.mjs       开发用静态服务器（浏览器里跑界面验证页）
  ui/index.html        界面布局验证页（设定界面 / 跑团界面）
  ui/bench.html        流式渲染性能基准
  ui/bench-main.cjs    在真实窗口里跑性能基准（Electron）
```

分层原则：`core/` 不碰 DOM 与 Electron，`ui/` 只读状态写 DOM，`services/` 只发请求，`app.js` 只做装配。

## 开发

```powershell
.\start.ps1                  # 启动开发版
npm test                     # 跑全部测试（655 项）
node tests\rules.test.mjs    # 只跑规则测试（138 项）
node tests\unit.test.mjs     # 只跑协议/工具测试（476 项）
```

### 界面布局验证

改样式时不必反复启动程序：先起静态服务，再用浏览器打开验证页。

```powershell
node tools\dev-server.mjs            # 默认 127.0.0.1:8931
```

- `tools/ui/index.html?view=setup` —— 开局设定界面
- `tools/ui/index.html?view=game` —— 跑团界面（三栏）
- 加 `&measure=1` 会把实测几何写进页面，可用无头浏览器 `--dump-dom` 抓取核对

### 性能基准

流式渲染的合帧行为（每帧最多写一次 DOM）在 `src/ui/messages.js` 里实现。
基准页要在**真实显示窗口**里跑，因为被测代码靠 `requestAnimationFrame` 合帧，
而隐藏窗口、后台标签、无头浏览器的 `--virtual-time-budget` 都会把 rAF 节流甚至饿死，
测出来的耗时和写入次数不可信（基准页会自检并标注 `trustworthy: false`）。

```powershell
node_modules\electron\dist\electron.exe tools\ui\bench-main.cjs
```


## 关于 AI 接口的说明

API Key 存在主进程的配置文件里（`%APPDATA%\coc-keeper\data\config.json`），不会进入网页层。所有请求由主进程发起，避免跨域问题。

队友可以用另一套模型省钱：设置里的「队友模型」填本地小模型，KP 用大模型。
