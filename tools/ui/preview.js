// ---------------------------------------------------------------------------
// UI 布局验证（开发用，不随程序分发）
//
// 目的：不启动 Electron 也能在真实浏览器里渲染界面，用来检查
//   1) 设定界面的双栏布局在宽窗口下是否把宽度真正用起来了
//   2) 模组简介面板的排版，以及它确实不剧透
//   3) 跑团界面的三栏布局在宽屏下的宽度利用率
//
// 用法：浏览器打开 tools/ui/index.html（建议窗口拉到 1440 以上）
//      ?view=setup    只测设定界面（默认）
//      ?view=game     只测跑团界面
//      ?measure=1     把实测几何写进 DOM，供 --dump-dom 抓取核对
// ---------------------------------------------------------------------------
import { openGameSetup } from '../../src/modals/gameSetup.js';
import { createCharacter } from '../../src/core/character.js';
import { createInitialState } from '../../src/state.js';
import { renderAll, renderScene } from '../../src/ui/panels.js';
import { renderAllMessages, initMessageScroll } from '../../src/ui/messages.js';

// 一份带公开简介的「已导入模组」，模拟 AI 整理后的产物
const importedModule = {
  id: 'imported-demo',
  title: '潮汐下的回声',
  importedAt: Date.now(),
  raw: '【潮汐下的回声】\n时代：现代\n地点：北方港口小城\n\n真相：这里不该被玩家看到。',
  understanding: {
    summary:
      '北方港口小城连续三个月有人在同一片防波堤附近失踪，警方草草结案，家属凑钱请你们来查。' +
      '海雾、潮汐与一份被涂改过的港务记录，构成一场需要耐心比对细节的调查。' +
      '节奏偏慢，正面冲突少，适合喜欢翻档案、跑现场、和人磨嘴皮子的队伍。',
    era: '现代',
    location: '北方港口小城',
    suggestions: [
      '记者：能查到警方不愿公开的记录',
      '海洋学者：读得懂潮汐表与海图',
      '本地向导：知道哪些码头晚上不能去',
      '律师：和港务局打交道时用得上'
    ]
  },
  materials: { docs: [{ rel: '正文.docx' }], images: [], skipped: [] }
};

window.api = {
  listModules: async () => [importedModule],
  readSave: async () => null,
  writeSave: async () => true
};

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'setup';

// ---------------------------------------------------------------------------
// 跑团界面：直接复用真实的 state / 渲染函数，不经过 app.js 的事件绑定
// ---------------------------------------------------------------------------
function mountGameView() {
  // 用真实的 index.html 结构，保证测的是线上那套 DOM
  const start = document.createElement('div');
  start.id = 'startScreen';
  start.hidden = true;
  start.className = 'start-screen';

  const app = document.createElement('div');
  app.id = 'app';
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="sigil">◈</span>
        <span class="title">克苏鲁的呼唤</span>
        <span class="subtitle">AI 守密人</span>
      </div>
      <div class="top-actions">
        <span id="connStatus" class="conn-status">未配置</span>
        <button class="btn ghost" id="btnBackToMenu">‹ 主界面</button>
        <button class="btn ghost" id="btnModules">模组</button>
        <button class="btn ghost" id="btnSaves">存档</button>
        <button class="btn ghost" id="btnSettings">设置</button>
      </div>
    </header>
    <main class="layout">
      <aside class="panel left-panel">
        <div class="panel-head"><h2>调查员</h2><button class="icon-btn" id="btnNewChar">+</button></div>
        <div id="charList" class="char-list"></div>
        <div class="panel-head" style="margin-top:18px"><h2>队友</h2><button class="icon-btn" id="btnAddTeammate">+</button></div>
        <div id="teammateList" class="teammate-list"></div>
      </aside>
      <section class="panel center-panel">
        <div class="scene-bar">
          <span class="scene-label">场景</span>
          <span id="sceneName" class="scene-name">尚未开始</span>
          <span id="turnCounter" class="turn-counter"></span>
        </div>
        <div id="messages" class="messages"></div>
        <div class="composer">
          <textarea id="input" rows="2" placeholder="你要做什么？"></textarea>
          <div class="composer-actions">
            <button class="btn" id="btnSend">行动</button>
            <button class="btn ghost" id="btnAuto">队友插话</button>
          </div>
        </div>
      </section>
      <aside class="panel right-panel">
        <div class="panel-head"><h2>状态</h2></div>
        <div id="statusPane" class="status-pane"></div>
        <div class="panel-head" style="margin-top:18px"><h2>线索</h2></div>
        <div id="clueList" class="clue-list"></div>
        <div class="panel-head" style="margin-top:18px"><h2>日志</h2></div>
        <div id="rollLog" class="roll-log"></div>
      </aside>
    </main>`;
  document.body.appendChild(start);
  document.body.appendChild(app);

  // 真实状态：一位调查员 + 两位队友 + 几条消息
  const state = createInitialState();
  state.mode = 'player';
  state.apiConfig = { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b', apiKey: '' };
  state.playerChar = createCharacter({ name: '林默', occupation: '记者', isPlayer: true });
  state.teammates = [
    createCharacter({ name: '陈砚', occupation: '医生', isPlayer: false }),
    createCharacter({ name: '老周', occupation: '退役军警', isPlayer: false })
  ];
  state.scenario.scene = '旧宅书房';
  state.scenario.clues = ['火漆信的封口有螺旋纹', '账本上记着大量盐与铁钉'];
  state.messages = [
    { id: 'welcome', role: 'keeper', text: '深夜，你在朋友的旧宅里整理遗物。窗外雨声绵密，灯忽明忽暗。', clean: '深夜，你在朋友的旧宅里整理遗物。窗外雨声绵密，灯忽明忽暗。' },
    { id: 'u1', role: 'user', text: '我先看看那封信，但不拆开，只看信封和火漆。' },
    {
      id: 'k1',
      role: 'keeper',
      text: '信封是厚实的亚麻纸，边角被湿气沤得发软。火漆上的螺旋纹不是任何已知的纹章，纹路细密得像指纹。[[SAY: 管家 | 那封信……老爷交代过不要碰。]]他把灯举高了些，手在抖。',
      clean: '信封是厚实的亚麻纸，边角被湿气沤得发软。火漆上的螺旋纹不是任何已知的纹章，纹路细密得像指纹。他把灯举高了些，手在抖。',
      says: [{ name: '管家', text: '那封信……老爷交代过不要碰。' }],
      segments: [
        { kind: 'prose', text: '信封是厚实的亚麻纸，边角被湿气沤得发软。火漆上的螺旋纹不是任何已知的纹章，纹路细密得像指纹。' },
        { kind: 'say', name: '管家', text: '那封信……老爷交代过不要碰。' },
        { kind: 'prose', text: '他把灯举高了些，手在抖。' }
      ]
    },
    { id: 't1', role: 'teammate', name: '林默', text: '这螺旋纹……我在哪本旧书里见过。别急着拆，先让我想想。' },
    { id: 't2', role: 'teammate', name: '周叙', text: '想什么想，管家都不敢碰，你倒想拆。' }
  ];

  initMessageScroll();
  renderAllMessages(state.messages);
  renderAll(state, {});
  renderScene(state);
  return state;
}

// ---------------------------------------------------------------------------
// 按 view 参数决定渲染哪一层
// ---------------------------------------------------------------------------
if (view === 'game') {
  mountGameView();
} else {
  const state = { apiConfig: {}, teammates: [], tone: '经典恐怖', module: null };
  await openGameSetup({
    onStart: (cfg) => console.log('onStart', cfg),
    state,
    api: {}
  });
  // 默认点一下内置模组，方便一眼看到简介面板的实际效果
  const rows = document.querySelectorAll('.setup-mod-row');
  if (rows.length > 1) rows[1].click();
}

// ---------------------------------------------------------------------------
// 布局自检：URL 带 ?measure=1 时，把关键元素的实测几何写进 DOM，
// 供 --dump-dom 抓出来做定量核对（不需要看图也能验证布局是否生效）
// ---------------------------------------------------------------------------
if (params.get('measure') === '1') {
  requestAnimationFrame(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const report = { view, viewport: { w: vw, h: vh } };

    if (view === 'game') {
      const layout = r('.layout');
      const left = r('.left-panel');
      const center = r('.center-panel');
      const right = r('.right-panel');
      const messages = r('#messages');
      report.layout = layout;
      report.left = left;
      report.center = center;
      report.right = right;
      report.messages = messages;
      // 三栏是否真的并排
      report.threeCols =
        left && center && right && Math.abs(left.y - center.y) < 4 && Math.abs(center.y - right.y) < 4;
      // 中间叙事区占窗口宽度的比例（越大越说明宽度被用起来了）
      report.centerRatio = center ? +(center.w / vw).toFixed(3) : null;
      // 侧栏占比
      report.sideRatio = left && right ? +((left.w + right.w) / vw).toFixed(3) : null;

      // 气泡实际宽度：超宽屏下应该被 max-width 收住，
      // 而不是跟着叙事区一起无限拉长（一行过百字读起来会串行）
      const kb = r('.msg.keeper .bubble');
      const ub = r('.msg.user .bubble');
      report.keeperBubble = kb;
      report.userBubble = ub;
      report.keeperLineLen = kb ? Math.round(kb.w / 15) : null; // 15px 字号粗估每行字数
      // user 气泡应该贴右边：右边缘接近 messages 区右边缘
      report.userAlignedRight =
        ub && messages ? Math.abs(ub.x + ub.w - (messages.x + messages.w)) < 60 : null;
    } else {
      const modal = r('.setup-modal');
      const grid = r('.setup-grid');
      const colMain = r('.setup-col-main');
      const colSide = r('.setup-col-side');
      const brief = r('.setup-brief');
      report.modal = modal;
      report.grid = grid;
      report.colMain = colMain;
      report.colSide = colSide;
      report.brief = brief;
      report.modList = r('.setup-mod-list');
      report.charList = r('.char-card-list');
      // 双栏是否真的并排（两栏 y 接近、x 不同）
      report.sideBySide =
        colMain && colSide && Math.abs(colMain.y - colSide.y) < 4 && colSide.x > colMain.x;
      // 宽度利用率：弹窗占视口宽度的比例
      report.modalRatio = modal ? +(modal.w / vw).toFixed(3) : null;
      report.gridFill =
        grid && colMain && colSide ? +((colMain.w + colSide.w) / grid.w).toFixed(3) : null;

      const briefText = document.querySelector('#setupBrief')?.textContent || '';
      report.briefChars = briefText.trim().length;
      report.leaks = ['黄衣之王', '回声', '封印', '真相', '终局', '阁楼', '玛莎', '汤姆'].filter((w) =>
        briefText.includes(w)
      );
      report.suggCount = document.querySelectorAll('.sb-sugg li').length;
    }

    report.modRowCount = document.querySelectorAll('.setup-mod-row').length;
    report.charRowCount = document.querySelectorAll('.char-row').length;
    report.msgCount = document.querySelectorAll('.msg').length;

    const out = document.createElement('pre');
    out.id = 'measureReport';
    out.textContent = JSON.stringify(report, null, 2);
    out.style.cssText =
      'position:fixed;left:0;top:0;z-index:9999;background:#000;color:#0f0;font:12px monospace;padding:8px;max-width:100vw;';
    document.body.appendChild(out);
  });
}
