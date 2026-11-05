// ---------------------------------------------------------------------------
// 设定界面 + 角色卡库 渲染冒烟测试
//
// 重点验证：
//   1) 角色卡库能分两个库渲染、切 tab、数量角标正确
//   2) 设定界面能渲染伙伴区、导入/存库按钮
//   3) 「添加伙伴」真的能把库里的卡加进伙伴列表
//   4) 点「开始游戏」时 companions 被带进 onStart
//
// 直接 node tests/gameSetup.smoke.mjs
// ---------------------------------------------------------------------------

// ---- 极简 DOM 桩（与 charEditor.smoke 同一套思路）----
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
    this._handlers = {};
    this.id = '';
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      toggle: (c, on) => { if (on) this.classList._set.add(c); else this.classList._set.delete(c); },
      contains: (c) => this.classList._set.has(c)
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = v;
    this.children = [];
    if (v) parseInto(v, this);
  }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); }
  addEventListener(t, fn) { this._handlers[t] = fn; }
  get onclick() { return this._handlers.click; }
  set onclick(fn) { this._handlers.click = fn; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  get textContent() { return this._text || ''; }
  set textContent(v) { this._text = v; }
  get isConnected() { return true; }
}

function queryAll(root, sel) {
  const out = [];
  const candidates = [];
  const walk = (n) => { for (const c of n.children) { candidates.push(c); walk(c); } };
  walk(root);
  const parts = sel.trim().split(/\s+/);
  const simple = parts[parts.length - 1];
  for (const node of candidates) if (matchSimple(node, simple)) out.push(node);
  return out;
}

function matchSimple(node, sel) {
  if (!sel) return false;
  const idM = sel.match(/#([\w-]+)/);
  if (idM && node.id !== idM[1]) return false;
  const clsM = sel.match(/\.([\w-]+)/);
  if (clsM && !node.className.split(/\s+/).includes(clsM[1])) return false;
  const attrM = sel.match(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g) || [];
  for (const am of attrM) {
    const m = am.match(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/);
    const name = m[1];
    const val = m[2];
    const actual = name.startsWith('data-') ? node.dataset[name.slice(5)] : node[name];
    if (val === undefined) { if (actual === undefined) return false; }
    else if (String(actual) !== val) return false;
  }
  if (!idM && !clsM && attrM.length === 0 && sel) {
    if (!/^[\w-]+$/.test(sel)) return true;
    if (node.tagName !== sel.toUpperCase()) return false;
  }
  return true;
}

/** 把 HTML 里带 id / data-* 的元素注册成可查询桩节点 */
function parseInto(html, container) {
  let m;
  const idRe = /<(\w+)[^>]*\bid="([\w-]+)"[^>]*>/g;
  while ((m = idRe.exec(html))) {
    const el = new El(m[1]);
    el.id = m[2];
    const tagStr = m[0];
    const cls = tagStr.match(/class="([^"]*)"/);
    if (cls) el.className = cls[1];
    registerData(el, tagStr);
    container.appendChild(el);
  }
  const dataRe = /<(\w+)[^>]*\bdata-([\w-]+)="([^"]*)"[^>]*>/g;
  while ((m = dataRe.exec(html))) {
    const el = new El(m[1]);
    const raw = m[2];
    el.dataset[raw] = m[3];
    if (raw.includes('-')) {
      el.dataset[raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[3];
    }
    const tagStr = m[0];
    const cls = tagStr.match(/class="([^"]*)"/);
    if (cls) el.className = cls[1];
    const valM = tagStr.match(/value="([^"]*)"/);
    if (valM) el.value = valM[1];
    container.appendChild(el);
  }
  return container;
}

function registerData(el, tagStr) {
  const dataRe = /data-([\w-]+)="([^"]*)"/g;
  let dm;
  while ((dm = dataRe.exec(tagStr))) {
    const raw = dm[1];
    el.dataset[raw] = dm[2];
    if (raw.includes('-')) {
      el.dataset[raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = dm[2];
    }
  }
}

// ---- 全局环境 ----
const modalRoot = new El();
modalRoot.id = 'modalRoot';

globalThis.document = {
  querySelector: (sel) => (sel === '#modalRoot' ? modalRoot : null),
  createElement: (t) => new El(t),
  addEventListener: () => {}
};
globalThis.window = { api: {}, addEventListener: () => {} };
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.alert = (m) => { globalThis.__alert = m; };

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---- 假角色卡库 ----
const libPlayer = [
  { id: 'p1', name: '阿远', savedAt: 100, char: { name: '阿远', occupation: '记者', derived: { HP: 11, SAN: 55, MP: 11, LUCK: 60 } } }
];
const libAi = [
  { id: 'a1', name: '老周', savedAt: 200, char: { name: '老周', occupation: '退伍军人', derived: { HP: 14, SAN: 50, MP: 10, LUCK: 45 } } },
  { id: 'a2', name: '小满', savedAt: 100, char: { name: '小满', occupation: '护士', derived: { HP: 9, SAN: 65, MP: 13, LUCK: 50 } } }
];

const savedCalls = [];
globalThis.window.api = {
  listModules: async () => [],
  listChars: async (kind) => (kind === 'player' ? libPlayer : libAi),
  saveChar: async (kind, char, opts) => { savedCalls.push({ kind, name: char.name, opts }); return { ok: true, id: 'new' }; },
  deleteChar: async () => ({ ok: true })
};

const { openCharLibrary } = await import('../src/modals/charLibrary.js');
const { openGameSetup } = await import('../src/modals/gameSetup.js');

const lastModal = () => modalRoot.children[modalRoot.children.length - 1];

// ---------------------------------------------------------------------------
(async () => {
  // ===== 角色卡库 =====
  console.log('== 角色卡库渲染 ==');
  await openCharLibrary({});

  const bd = lastModal();
  ok(bd, '弹窗已打开');

  // 默认停在玩家库
  const tabs = bd.querySelectorAll('.charlib-tab');
  eq(tabs.length, 2, '有两个库的 tab');
  ok(tabs[0].classList.contains('on'), '默认选中玩家库');

  // 数量角标
  eq(bd.querySelector('[data-count="player"]').textContent, '1', '玩家库角标 1');
  eq(bd.querySelector('[data-count="ai"]').textContent, '2', 'AI 库角标 2');

  // 玩家库里只有阿远
  const cards = bd.querySelectorAll('.charlib-card');
  eq(cards.length, 1, '玩家库渲染出 1 张卡');
  ok(cards[0].innerHTML.includes('阿远'), '卡片显示名字');
  ok(cards[0].innerHTML.includes('记者'), '卡片显示职业');
  ok(!cards[0].innerHTML.includes('老周'), '玩家库里没有 AI 卡');

  // 切到 AI 库
  tabs[1].onclick();
  const aiCards = bd.querySelectorAll('.charlib-card');
  eq(aiCards.length, 2, 'AI 库渲染出 2 张卡');
  ok(aiCards.some((c) => c.innerHTML.includes('老周')), 'AI 库里有老周');
  ok(bd.querySelector('[data-count="player"]').textContent === '1', '切 tab 后玩家角标不变');

  // 每个库里都有「复制到另一库」按钮
  const copyBtns = bd.querySelectorAll('[data-act="copy"]');
  ok(copyBtns.length > 0, '有复制到另一库的按钮');
  ok(copyBtns[0].parentNode, '复制按钮挂在卡片上');

  bd.remove();

  // ===== 设定界面 =====
  console.log('== 设定界面：伙伴区 ==');
  let started = null;
  await openGameSetup({ onStart: (cfg) => { started = cfg; }, state: null, api: window.api });

  const sbd = lastModal();
  ok(sbd, '设定界面已打开');

  // 伙伴区存在
  const cpList = sbd.querySelector('#companionList');
  ok(cpList, '伙伴列表存在');
  const addBtn = sbd.querySelector('#btnAddCompanion');
  ok(addBtn, '有「添加伙伴」按钮');

  // 初始没有伙伴：空态提示会挂在列表里，但没有伙伴行
  eq(cpList.querySelectorAll('.companion-row').length, 0, '初始没有伙伴行');
  const emptyHint = cpList.children.find((c) => c.className.includes('empty-hint'));
  ok(emptyHint && emptyHint.textContent.includes('还没有添加伙伴'), '初始显示空态提示');

  // 角色卡区有导入按钮（玩家 + 队友各一个）
  const importBtns = sbd.querySelectorAll('[data-act="import"]');
  ok(importBtns.length >= 2, `角色卡有导入按钮（实际 ${importBtns.length} 个）`);

  // 有存库按钮
  const saveBtns = sbd.querySelectorAll('[data-act="save"]');
  ok(saveBtns.length >= 2, `角色卡有存库按钮（实际 ${saveBtns.length} 个）`);

  // ===== 添加伙伴：真的走一遍选卡流程 =====
  console.log('== 添加伙伴流程 ==');
  const addPromise = addBtn.onclick();
  await new Promise((r) => setTimeout(r, 0));

  const pickModal = lastModal();
  ok(pickModal, '选卡弹窗打开了');
  const pickRows = pickModal.querySelectorAll('.pick-row');
  eq(pickRows.length, 2, '选卡弹窗列出 AI 库的 2 张卡');
  ok(pickRows[0].innerHTML.includes('老周'), '选卡列表第一张是老周');

  // 点第一张 → 应该加进伙伴
  pickRows[0].onclick();
  await addPromise;
  await new Promise((r) => setTimeout(r, 0));

  const cpRows = sbd.querySelectorAll('.companion-row');
  eq(cpRows.length, 1, '伙伴列表多了 1 行');
  ok(cpRows[0].innerHTML.includes('老周'), '加进来的是老周');
  ok(cpRows[0].innerHTML.includes('退伍军人'), '伙伴显示职业');

  // 再添加同一张卡：应该被去重拦住
  addBtn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  const pick2 = lastModal();
  pick2.querySelectorAll('.pick-row')[0].onclick();
  await new Promise((r) => setTimeout(r, 0));
  eq(sbd.querySelectorAll('.companion-row').length, 1, '重复添加同一张卡被拦住');

  // ===== 开始游戏时 companions 被带出 =====
  console.log('== 开局配置透传 ==');
  sbd.querySelector('#btnBeginGame').onclick();
  ok(started, 'onStart 被调用');
  ok(Array.isArray(started.companions), 'onStart 收到 companions 数组');
  eq(started.companions.length, 1, '带出 1 位伙伴');
  eq(started.companions[0].name, '老周', '带出的伙伴是老周');

  // 收尾
  console.log('\n' + '='.repeat(42));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  } else {
    console.log('全部通过');
  }
})();
