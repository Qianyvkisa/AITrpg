// ---------------------------------------------------------------------------
// 长局性能 · 窗口化渲染测试
//
// 背景：一局跑几百轮后消息能到一万条。全部塞进 DOM 时，流式输出每帧
// 都要重排三万个节点，界面卡死。修复方式是只渲染最近 RENDER_WINDOW 条。
//
// 这里验证四件事：
//   1) 一万条消息只渲染窗口大小那么多条
//   2) 窗口内容是**最新的**那些（不是最早的）
//   3) 「更早的记录」能往前翻，且滚动位置被补偿
//   4) 超长局面自动关掉入场动画
//
// 直接 node tests/perfWindow.dom.test.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DOM 桩：这次需要更完整的子节点操作（insertBefore / DocumentFragment）
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
    this.isConnected = true;
    this._scrollTop = 0;
    this._scrollHeight = 0;
    this._clientHeight = 0;
    this.classList = {
      add: (c) => this._set.add(c),
      remove: (c) => this._set.delete(c),
      toggle: (c, on) => { if (on) this._set.add(c); else this._set.delete(c); },
      contains: (c) => this._set.has(c)
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(c) {
    if (c instanceof Frag) {
      for (const k of c.children) { k.parentNode = this; this.children.push(k); }
      c.children = [];
      return c;
    }
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(node, ref) {
    const list = node instanceof Frag ? node.children.slice() : [node];
    const idx = ref ? this.children.indexOf(ref) : this.children.length;
    const at = idx < 0 ? this.children.length : idx;
    for (const k of list) k.parentNode = this;
    this.children.splice(at, 0, ...list);
    if (node instanceof Frag) node.children = [];
    return node;
  }
  addEventListener(t, fn) { this._handlers[t] = fn; }
  removeEventListener() {}
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** 递归数所有后代节点 */
  countAll() {
    let n = this.children.length;
    for (const c of this.children) n += c.countAll ? c.countAll() : 0;
    return n;
  }
  _scrollTo(top, height, client) {
    this._scrollHeight = height;
    this._clientHeight = client;
    this._scrollTop = top;
    this._handlers.scroll?.();
  }
}

class Frag extends El {
  constructor() { super('#fragment'); }
}

// 真实浏览器的 scrollTop 夹值语义（scrollToBottom 写入 1e9 靠它夹住）
Object.defineProperty(El.prototype, 'scrollTop', {
  get() { return this._scrollTop ?? 0; },
  set(v) {
    const max = Math.max(0, (this._scrollHeight ?? 0) - (this._clientHeight ?? 0));
    this._scrollTop = Math.max(0, Math.min(v, max));
  },
  configurable: true
});
Object.defineProperty(El.prototype, 'scrollHeight', {
  get() { return this._scrollHeight ?? 0; },
  set(v) { this._scrollHeight = v; },
  configurable: true
});
Object.defineProperty(El.prototype, 'clientHeight', {
  get() { return this._clientHeight ?? 0; },
  set(v) { this._clientHeight = v; },
  configurable: true
});

// 全局 document 桩
const els = {
  '#messages': new El('div'),
  '#btnScrollBottom': new El('button'),
  '#btnEarlier': new El('button')
};
els['#btnScrollBottom'].hidden = true;
els['#btnEarlier'].hidden = true;

globalThis.document = {
  querySelector: (sel) => els[sel] ?? null,
  createElement: (tag) => new El(tag),
  createDocumentFragment: () => new Frag()
};

const { renderAllMessages, showEarlier, hasEarlierMessages } =
  await import('../src/ui/messages.js');

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/** 造 n 条普通消息 */
function makeMessages(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `m${i}`,
      role: i % 3 === 0 ? 'user' : 'keeper',
      text: `第 ${i} 条消息的内容`,
      ts: 1700000000000 + i * 1000
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log('\n== 一万条消息只渲染窗口大小 ==');

{
  const all = makeMessages(10000);
  const m = els['#messages'];
  m._scrollHeight = 100000;
  m._clientHeight = 800;

  renderAllMessages(all);

  // 每条普通消息产生 1 个 .msg 节点（含 role + bubble 两个子节点 = 3 节点）
  const rendered = m.children.length;
  ok(rendered <= 200, `渲染条数不超过窗口上限（实际 ${rendered}）`);
  ok(rendered > 0, '确实渲染了内容');
  ok(rendered < 10000, '远少于总条数');
}

// ---------------------------------------------------------------------------
console.log('\n== 窗口内容是「最新的」那些 ==');

{
  const all = makeMessages(1000);
  const m = els['#messages'];
  m._scrollHeight = 50000;
  m._clientHeight = 800;

  renderAllMessages(all);

  // 最后一个渲染的节点应该对应最后一条消息
  const last = m.children[m.children.length - 1];
  eq(last.dataset.msgId, 'm999', '窗口末尾是最新一条消息');

  // 第一个渲染的应该是第 800 条（1000 - 200）
  const first = m.children[0];
  eq(first.dataset.msgId, 'm800', '窗口起点是倒数第 200 条');
}

// ---------------------------------------------------------------------------
console.log('\n== 「更早的记录」往前翻 ==');

{
  const all = makeMessages(1000);
  const m = els['#messages'];
  m._scrollHeight = 50000;
  m._clientHeight = 800;

  renderAllMessages(all);
  eq(m.children.length, 200, '初始窗口 200 条');
  ok(hasEarlierMessages(), '标记为还有更早的');
  ok(!els['#btnEarlier'].hidden, '「更早的记录」按钮可见');

  // 往前加载
  const beforeCount = m.children.length;
  const ok1 = showEarlier();

  ok(ok1, 'showEarlier 返回成功');
  eq(m.children.length, beforeCount + 200, '又加载了 200 条');
  eq(m.children[0].dataset.msgId, 'm600', '新加载的是更早的那批');
}

// ---------------------------------------------------------------------------
console.log('\n== 加载更早时补偿滚动位置 ==');

{
  const all = makeMessages(1000);
  const m = els['#messages'];

  // 模拟：内容 50000 高，视口 800，当前滚到 20000
  m._scrollHeight = 50000;
  m._clientHeight = 800;
  renderAllMessages(all);

  m._scrollHeight = 50000;
  m._scrollTop = 20000;

  // 插入更早内容后，真实浏览器里 scrollHeight 会变大
  const originalDescriptor = Object.getOwnPropertyDescriptor(El.prototype, 'scrollHeight');
  let grew = false;
  Object.defineProperty(m, 'scrollHeight', {
    get() { return grew ? 60000 : 50000; },
    set(v) { /* 忽略桩内赋值 */ },
    configurable: true
  });

  // insertBefore 之后才读 scrollHeight，模拟「插入导致变高」
  const origInsert = m.insertBefore.bind(m);
  m.insertBefore = function (node, ref) {
    const r = origInsert(node, ref);
    grew = true;
    return r;
  };

  showEarlier();

  // 插入前 top=20000，高度涨了 10000，所以应补偿到 30000
  eq(m.scrollTop, 30000, '滚动位置被补偿，视图不跳');

  Object.defineProperty(El.prototype, 'scrollHeight', originalDescriptor);
  delete m.insertBefore;
}

// ---------------------------------------------------------------------------
console.log('\n== 翻到头后按钮消失 ==');

{
  const all = makeMessages(300);
  const m = els['#messages'];
  m._scrollHeight = 20000;
  m._clientHeight = 800;

  renderAllMessages(all);

  // 300 条 < 窗口 200？不，300 > 200，所以初始窗口起点是 100
  ok(hasEarlierMessages(), '300 条时有更早的');

  showEarlier();
  ok(!hasEarlierMessages(), '翻到头后没有更早的了');
  ok(els['#btnEarlier'].hidden, '按钮隐藏');
}

// ---------------------------------------------------------------------------
console.log('\n== 短局：全部渲染，无「更早」按钮 ==');

{
  const all = makeMessages(50);
  const m = els['#messages'];
  m._scrollHeight = 5000;
  m._clientHeight = 800;

  renderAllMessages(all);

  eq(m.children.length, 50, '短局全部渲染');
  ok(!hasEarlierMessages(), '短局没有更早的');
  ok(els['#btnEarlier'].hidden, '短局按钮隐藏');
}

// ---------------------------------------------------------------------------
console.log('\n== 超长局面关掉入场动画 ==');

{
  const m = els['#messages'];

  // 长局
  m._scrollHeight = 100000;
  m._clientHeight = 800;
  renderAllMessages(makeMessages(1000));
  ok(m.classList.contains('long-log'), '长局加 long-log 类（关动画）');

  // 短局
  const m2 = new El('div');
  els['#messages'] = m2;
  m2._scrollHeight = 5000;
  m2._clientHeight = 800;
  renderAllMessages(makeMessages(50));
  ok(!m2.classList.contains('long-log'), '短局保留入场动画');

  els['#messages'] = m;
}

// ---------------------------------------------------------------------------
console.log('\n== 边界情况 ==');

{
  const m = els['#messages'];
  m._scrollHeight = 1000;
  m._clientHeight = 800;

  renderAllMessages([]);
  eq(m.children.length, 0, '空数组不报错');
  ok(!hasEarlierMessages(), '空数组没有更早的');

  renderAllMessages(null);
  eq(m.children.length, 0, 'null 不报错');
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
