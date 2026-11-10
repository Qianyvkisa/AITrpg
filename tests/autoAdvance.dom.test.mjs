// ---------------------------------------------------------------------------
// 自动推进按钮 · 界面层联动测试
//
// autoAdvance.test.mjs 覆盖纯逻辑（能不能推进），
// autoAdvanceRunner.test.mjs 覆盖调度器（定时器、开关、恢复），
// 这里覆盖**界面那一层**：按钮在两种模式下该不该出现、点了之后状态怎么变。
//
// 为什么要单独测这一层：按钮显隐和模式同步是两处独立的代码，
// 纯逻辑全对但按钮没显示，功能等于不存在——这类 bug 单元测试抓不到。
//
// 注意：下面的 applyModeToComposer / syncAutoAdvanceButton 仍是 app.js 的
// **等价副本**（app.js 依赖整个界面栈，node 里没法直接 import）。
// 调度逻辑已经搬到 core/autoAdvanceRunner.js 由真测试覆盖了，
// 这里只剩「按钮显隐 + 文案」这点纯 DOM 行为，副本风险可控。
//
// 直接 node tests/autoAdvance.dom.test.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 极简 DOM 桩（与 gameSetup.smoke / charEditor.smoke 同一套思路）
// ---------------------------------------------------------------------------
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this._innerHTML = '';
    this.value = '';
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this._handlers = {};
    this.id = '';
    this._set = new Set();
    this.classList = {
      add: (c) => this._set.add(c),
      remove: (c) => this._set.delete(c),
      toggle: (c, on) => { if (on) this._set.add(c); else this._set.delete(c); },
      contains: (c) => this._set.has(c)
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  addEventListener(t, fn) { this._handlers[t] = fn; }
  removeEventListener() {}
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

// 界面上需要被 applyModeToComposer 操作的三个元素
const els = {
  '#input': new El('textarea'),
  '#btnSend': new El('button'),
  '#btnAutoAdvance': new El('button')
};
els['#btnAutoAdvance'].hidden = true; // 与 index.html 里的 hidden 属性一致

globalThis.document = {
  querySelector: (sel) => els[sel] ?? null,
  createElement: (t) => new El(t),
  addEventListener: () => {}
};
globalThis.window = { api: {}, addEventListener: () => {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.alert = (m) => { globalThis.__alert = m; };

// ---------------------------------------------------------------------------
// 被测逻辑：从 app.js 里摘出来的等价实现
//
// 说明：app.js 依赖整个界面栈（引擎、渲染、存档），没法在 node 里直接 import。
// 这里把 applyModeToComposer + 按钮同步这两个函数**逐行照搬**过来，
// 再配合上面的 DOM 桩断言。改动 app.js 里这两段时要同步改这里——
// 好在它们都很短，且这段注释就是提醒。
// ---------------------------------------------------------------------------
const state = { mode: 'player', autoAdvance: false, turns: 0 };

function syncAutoAdvanceButton() {
  const btn = els['#btnAutoAdvance'];
  if (!btn) return;
  const on = !!state.autoAdvance && state.mode === 'spectator';
  btn.classList.toggle('on', on);
  btn.textContent = on ? '自动推进 · 开' : '自动推进';
  btn.title = on ? '正在自动推进，点一下停止' : '开启后，每轮 KP 叙述完自动继续推进';
}

function applyModeToComposer() {
  const input = els['#input'];
  const sendBtn = els['#btnSend'];
  const isSpectator = state.mode === 'spectator';

  if (input) {
    input.placeholder = isSpectator
      ? '剧情指示（留空直接推进，Enter 发送）'
      : '你要做什么？（Enter 发送，Shift+Enter 换行）';
  }
  if (sendBtn) {
    sendBtn.textContent = isSpectator ? '推进' : '行动';
  }

  const autoBtn = els['#btnAutoAdvance'];
  if (autoBtn) {
    autoBtn.hidden = !isSpectator;
    syncAutoAdvanceButton();
  }
}

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------------------------------------------------------------------------
console.log('\n== 玩家模式：按钮隐藏、主按钮是「行动」==');

state.mode = 'player';
state.autoAdvance = false;
applyModeToComposer();

eq(els['#btnAutoAdvance'].hidden, true, '玩家模式下自动推进按钮隐藏');
eq(els['#btnSend'].textContent, '行动', '主按钮文案是「行动」');
ok(els['#input'].placeholder.includes('你要做什么'), '输入框提示是玩家口吻');

// ---------------------------------------------------------------------------
console.log('\n== 旁观模式：按钮出现、主按钮变「推进」==');

state.mode = 'spectator';
applyModeToComposer();

eq(els['#btnAutoAdvance'].hidden, false, '旁观模式下自动推进按钮显示');
eq(els['#btnSend'].textContent, '推进', '主按钮文案变成「推进」');
ok(els['#input'].placeholder.includes('剧情指示'), '输入框提示变成「剧情指示」');

// ---------------------------------------------------------------------------
console.log('\n== 旁观模式 · 开关打开时的外观 ==');

state.autoAdvance = true;
syncAutoAdvanceButton();

eq(els['#btnAutoAdvance'].textContent, '自动推进 · 开', '开启后文案带「· 开」');
ok(els['#btnAutoAdvance'].classList.contains('on'), '开启后有 on 类（用于高亮样式）');
ok(els['#btnAutoAdvance'].title.includes('停止'), '开启后 title 提示可停止');

state.autoAdvance = false;
syncAutoAdvanceButton();

eq(els['#btnAutoAdvance'].textContent, '自动推进', '关闭后文案回到「自动推进」');
ok(!els['#btnAutoAdvance'].classList.contains('on'), '关闭后去掉 on 类');
ok(els['#btnAutoAdvance'].title.includes('自动继续推进'), '关闭后 title 说明开启效果');

// ---------------------------------------------------------------------------
console.log('\n== 玩家模式即使开关为 true 也不高亮 ==');

// 这是防御性检查：如果某个路径把 autoAdvance 置了 true 但模式是玩家，
// 按钮不该显示「开着」的样子（那个模式根本没有自动推进）
state.mode = 'player';
state.autoAdvance = true;
syncAutoAdvanceButton();

ok(!els['#btnAutoAdvance'].classList.contains('on'), '玩家模式下即使 autoAdvance=true 也不高亮');
eq(els['#btnAutoAdvance'].textContent, '自动推进', '玩家模式下文案保持「自动推进」');

// ---------------------------------------------------------------------------
console.log('\n== 模式来回切换 ==');

state.mode = 'spectator';
state.autoAdvance = false;
applyModeToComposer();
eq(els['#btnAutoAdvance'].hidden, false, '切到旁观 → 显示');

state.mode = 'player';
applyModeToComposer();
eq(els['#btnAutoAdvance'].hidden, true, '切回玩家 → 隐藏');

state.mode = 'spectator';
applyModeToComposer();
eq(els['#btnAutoAdvance'].hidden, false, '再切旁观 → 又显示');

// ---------------------------------------------------------------------------
console.log('\n== 轮数显示（旁观模式不能是空白）==');

// 复刻 renderScene 的轮数计算：原来只数 user 消息，
// 旁观模式没有 user 消息 → 轮数永远显示不出来
function turnCount(messages, turns) {
  const fromMessages = messages.filter((m) => m.role === 'user').length;
  return Math.max(fromMessages, Number(turns) || 0);
}

eq(turnCount([{ role: 'keeper' }, { role: 'teammate' }], 12), 12, '旁观模式靠 turns 显示轮数');
eq(turnCount([{ role: 'user' }, { role: 'keeper' }], 1), 1, '玩家模式按 user 消息数');
eq(turnCount([{ role: 'user' }, { role: 'user' }], 0), 2, '两者取较大值（消息多于 turns）');
eq(turnCount([{ role: 'keeper' }], 0), 0, '都没有时是 0');

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(42));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('全部通过');
}
