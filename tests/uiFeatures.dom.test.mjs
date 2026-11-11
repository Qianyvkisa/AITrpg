// ---------------------------------------------------------------------------
// 界面新功能 · DOM 层测试
//
// 覆盖三项「界面才有」的行为：
//   1) 「↓ 最新」按钮的显隐（上翻时出现、回底时消失）
//   2) token 指示器的显示与分级
//   3) 自动跟随不打断手动上翻
//
// 为什么这层必须单独测：纯逻辑全对但按钮不出现、或自动滚动把玩家正在看
// 的历史顶走，功能等于坏的——单元测试抓不到这类问题。
//
// messages.js 是真模块（不依赖整个界面栈），直接 import 测真代码；
// app.js 里的 updateTokenMeter 依赖整个应用状态，用等价副本覆盖它的
// 显示规则（与 autoAdvance.dom.test.mjs 同一套思路）。
//
// 直接 node tests/uiFeatures.dom.test.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 极简 DOM 桩（与 autoAdvance.dom.test.mjs 同一套）
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
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.classList = {
      add: (c) => this._set.add(c),
      remove: (c) => this._set.delete(c),
      toggle: (c, on) => { if (on) this._set.add(c); else this._set.delete(c); },
      contains: (c) => this._set.has(c)
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  addEventListener(t, fn) { this._handlers[t] = fn; }
  removeEventListener() {}
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** 模拟用户滚动到某位置 */
  _scrollTo(top, height, client) {
    this.scrollTop = top;
    this.scrollHeight = height;
    this.clientHeight = client;
    this._handlers.scroll?.();
  }
}

// 全局 document 桩：让 messages.js 能拿到 #messages 与 #btnScrollBottom
const els = {
  '#messages': new El('div'),
  '#btnScrollBottom': new El('button')
};
els['#btnScrollBottom'].hidden = true;

globalThis.document = {
  querySelector: (sel) => els[sel] ?? null,
  createElement: (tag) => new El(tag)
};

const { initMessageScroll, scrollToBottom } = await import('../src/ui/messages.js');

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------------------------------------------------------------------------
console.log('\n== 「↓ 最新」按钮：上翻时出现 ==');

{
  initMessageScroll();

  const m = els['#messages'];
  const btn = els['#btnScrollBottom'];

  // 初始：贴着底部 → 按钮隐藏
  m._scrollTo(1000, 1000, 200);   // scrollHeight - scrollTop - clientHeight = 200... 不对，重算
  // 贴着底部：scrollTop = scrollHeight - clientHeight
  m._scrollTo(800, 1000, 200);
  ok(btn.hidden, '贴底时按钮隐藏');

  // 用户上翻 → 按钮出现
  m._scrollTo(100, 1000, 200);
  ok(!btn.hidden, '上翻时按钮出现');

  // 再滚回底部 → 按钮消失
  m._scrollTo(800, 1000, 200);
  ok(btn.hidden, '回到底部后按钮又隐藏');
}

// ---------------------------------------------------------------------------
console.log('\n== 「↓ 最新」按钮：点击回到底部 ==');

{
  const m = els['#messages'];
  const btn = els['#btnScrollBottom'];

  // 上翻到中间
  m._scrollTo(100, 2000, 300);
  ok(!btn.hidden, '上翻后按钮可见');

  // 点按钮
  btn._handlers.click?.();

  eq(m.scrollTop, m.scrollHeight, '点击后滚到底部');
  ok(btn.hidden, '点击后按钮隐藏（已回底）');
}

// ---------------------------------------------------------------------------
console.log('\n== 自动跟随：贴底时自动下滑 ==');

{
  const m = els['#messages'];

  // 贴底状态
  m._scrollTo(800, 1000, 200);

  // 模拟新内容到达：内容变高，调用 scrollToBottom（流式每帧都会调）
  m.scrollHeight = 1500;
  scrollToBottom();

  eq(m.scrollTop, 1500, '新内容到达后自动滚到新的底部');
}

// ---------------------------------------------------------------------------
console.log('\n== 自动跟随：上翻时不打断玩家 ==');

{
  const m = els['#messages'];

  // 玩家正在看历史
  m._scrollTo(100, 1000, 200);
  const before = m.scrollTop;

  // 此时新内容到达
  m.scrollHeight = 1500;
  scrollToBottom();

  eq(m.scrollTop, before, '玩家上翻时不被强行拽回底部');
}

// ---------------------------------------------------------------------------
console.log('\n== 强制滚动（读档/进游戏）无视上翻 ==');

{
  const m = els['#messages'];

  m._scrollTo(100, 1000, 200);   // 上翻状态
  m.scrollHeight = 2000;

  scrollToBottom({ force: true });

  eq(m.scrollTop, 2000, 'force=true 时无视 stick 直接到底');
}

// ---------------------------------------------------------------------------
console.log('\n== token 指示器显示规则（app.js updateTokenMeter 的等价副本）==');

// 与 app.js 保持一致的实现
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1) + 'k';
  return Math.round(v / 1000) + 'k';
}

function meterState(usage) {
  // 返回 {hidden, text, warn, high}，与 updateTokenMeter 的分支一致
  if (!usage || !usage.calls) return { hidden: true };
  if (!usage.total) return { hidden: false, text: '用量未知', warn: false, high: false };
  return {
    hidden: false,
    text: formatTokens(usage.total),
    warn: usage.total >= 20000 && usage.total < 100000,
    high: usage.total >= 100000
  };
}

{
  eq(formatTokens(0), '0', '0 token');
  eq(formatTokens(999), '999', '小于 1000 显示原数');
  eq(formatTokens(1000), '1.0k', '1000 显示 1.0k');
  eq(formatTokens(12345), '12k', '12345 显示 12k');
  eq(formatTokens(123456), '123k', '大数显示 123k');
}

{
  eq(meterState(null).hidden, true, '没有请求时不显示');
  eq(meterState({ calls: 0 }).hidden, true, 'calls=0 不显示');
  eq(meterState({ calls: 1, total: 0 }).hidden, false, '有请求但无 usage 时显示');
  eq(meterState({ calls: 1, total: 0 }).text, '用量未知', '无 usage 时如实说未知');
}

{
  const s = meterState({ calls: 5, total: 12345 });
  eq(s.hidden, false, '有用量时显示');
  eq(s.text, '12k', '显示格式化后的数字');
  eq(s.warn, false, '1.2 万不告警');
  eq(s.high, false, '1.2 万不标红');
}

{
  eq(meterState({ calls: 5, total: 50000 }).warn, true, '5 万变黄告警');
  eq(meterState({ calls: 5, total: 50000 }).high, false, '5 万还不标红');
  eq(meterState({ calls: 5, total: 150000 }).high, true, '15 万标红');
}

// ---------------------------------------------------------------------------
console.log('\n== 导出按钮存在且文案正确 ==');

{
  // 静态确认 HTML 里有这三个元素（改 HTML 时能及时发现问题）
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');

  ok(/id="btnExport"/.test(html), 'HTML 里有导出按钮');
  ok(/导出记录/.test(html), '导出按钮文案正确');
  ok(/id="tokenMeter"/.test(html), 'HTML 里有 token 指示器');
  ok(/id="btnScrollBottom"/.test(html), 'HTML 里有回到最新按钮');
  ok(/含对话、行动、投点/.test(html), '导出按钮提示说明了内容');
}

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
