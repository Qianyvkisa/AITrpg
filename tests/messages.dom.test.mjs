// ---------------------------------------------------------------------------
// 消息气泡渲染的 DOM 回归测试
//
// 针对两个真实出现过的界面 bug：
//   BUG1 纯指令回复（KP 只写了 [[CHECK: ...]]）会在界面上留下一个空的
//        「守密人」气泡，下面什么都没有。
//   BUG2 对话结束（流式结束）后，气泡末尾的闪烁光标没有消失，
//        看起来像还在加载。
//
// 用最小 DOM 桩直接跑 src/ui/messages.js 的真实代码路径，
// 不依赖浏览器，随 npm test 一起执行。
// ---------------------------------------------------------------------------

// ---- 最小 DOM 桩：支持 .class 与 [data-msg-id="..."] 选择器 ----
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this.hidden = false;
    this.dataset = {};
    this._classes = new Set();
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self._classes.delete(c)),
      contains: (c) => self._classes.has(c),
      toggle: (c, on) => (on ? self._classes.add(c) : self._classes.delete(c))
    };
  }

  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }

  // 重建时会清空子节点；桩里不需要真的解析 HTML
  set innerHTML(_v) { this._text = ''; this.children = []; }
  get innerHTML() { return ''; }

  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }

  /** 沿祖先链判断自己（或祖先）是否被隐藏 */
  get inHiddenTree() {
    let n = this;
    while (n) {
      if (n.hidden) return true;
      n = n.parentNode;
    }
    return false;
  }

  matches(sel) {
    const attr = sel.match(/^\[data-msg-id="([^"]*)"\]$/);
    if (attr) return this.dataset.msgId === attr[1];
    if (sel.startsWith('.')) return this._classes.has(sel.slice(1));
    return false;
  }

  querySelector(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const r = c.querySelector(sel);
      if (r) return r;
    }
    return null;
  }

  querySelectorAll(sel, out = []) {
    for (const c of this.children) {
      if (c.matches(sel)) out.push(c);
      c.querySelectorAll(sel, out);
    }
    return out;
  }
}

// 消息容器
const root = new El('div');
root.className = 'messages';

// document 桩：必须能递归找到 [data-msg-id="..."]，
// 否则 findMsgEl 永远返回 null，测试会假通过。
globalThis.document = {
  querySelector(sel) {
    if (sel === '#messages') return root;
    const attr = sel.match(/^\[data-msg-id="([^"]*)"\]$/);
    if (attr) return root.querySelector(sel);
    return null;
  },
  createElement: (tag) => new El(tag)
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.cancelAnimationFrame = () => {};

const { renderMessage, applyCleanText, endStreamingBubble, renderAllMessages } =
  await import('../src/ui/messages.js');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.log('  FAIL: ' + name); }
}

/** 界面上真正看得见的气泡（排除被 hidden 隐藏的） */
function visibleBubbles() {
  return root.querySelectorAll('.bubble').filter((b) => !b.inHiddenTree);
}
/** 看得见但内容为空的气泡 = BUG1 */
function emptyVisibleBubbles() {
  return visibleBubbles().filter((b) => !b.textContent.trim());
}
/** 看得见的残留光标 = BUG2 */
function blinking() {
  return root.querySelectorAll('.cursor-blink').filter((b) => !b.inHiddenTree);
}

function reset() { root.children = []; }

// ---------------------------------------------------------------------------
console.log('\n== BUG1 纯指令回复不留空气泡 ==');
// ---------------------------------------------------------------------------
reset();
const w1 = renderMessage({
  id: 'a1', role: 'keeper', streaming: false,
  text: '[[CHECK: 侦查 | 角色=林默 | 原因=找线索]]', clean: '', says: []
});
ok(w1.hidden === true, '纯指令定稿后整条隐藏');
ok(emptyVisibleBubbles().length === 0, '纯指令定稿后没有可见空气泡');
ok(blinking().length === 0, '纯指令定稿后没有光标');

// 真实流程：先流式、再定稿
reset();
const b1 = renderMessage({ id: 'b1', role: 'keeper', streaming: true, text: '[[CHECK: 侦查]]' });
ok(b1 && !b1.hidden, '流式中不隐藏（给个占位让光标有处可闪）');
const b1bubble = b1.querySelector('.bubble');
ok(b1bubble && b1bubble.textContent.trim() !== '', '流式中占位不是空文本');
endStreamingBubble('b1');
applyCleanText({ id: 'b1', streaming: false, text: '[[CHECK: 侦查]]', clean: '' });
ok(emptyVisibleBubbles().length === 0, '流式→定稿后没有可见空气泡');
ok(blinking().length === 0, '流式→定稿后没有光标');

// ---------------------------------------------------------------------------
console.log('\n== BUG2 对话结束后光标必须消失 ==');
// ---------------------------------------------------------------------------
reset();
const c1 = renderMessage({ id: 'c1', role: 'keeper', streaming: true, text: '他擦着杯子。' });
ok(c1.querySelector('.bubble')?.classList.contains('cursor-blink') === true,
  '流式中确实有光标（前提成立，否则后面的断言无意义）');
endStreamingBubble('c1');
ok(blinking().length === 0, 'endStreaming 后光标消失');

// 带 NPC 台词的多气泡
reset();
const d1 = renderMessage({
  id: 'd1', role: 'keeper', streaming: true,
  text: '他擦着杯子。[[SAY: 酒保 | 要点什么？]]窗外下雨。'
});
ok(d1.querySelectorAll('.bubble').length >= 2, '多气泡确实拆开了');
endStreamingBubble('d1');
applyCleanText({
  id: 'd1', streaming: false,
  text: '他擦着杯子。[[SAY: 酒保 | 要点什么？]]窗外下雨。',
  clean: '他擦着杯子。窗外下雨。'
});
ok(blinking().length === 0, '多气泡定稿后没有光标残留');
ok(emptyVisibleBubbles().length === 0, '多气泡定稿后没有空气泡');
const roles = d1.querySelectorAll('.msg-role').map((r) => r.textContent);
ok(roles.includes('酒保'), 'NPC 说话人正确显示');
ok(!roles.some((r) => r === 'NPC'), '有名有姓的 NPC 不显示成泛称');

// ---------------------------------------------------------------------------
console.log('\n== 读档整场重绘同样干净 ==');
// ---------------------------------------------------------------------------
reset();
renderAllMessages([
  { id: 'e1', role: 'keeper', streaming: false, text: '开场。', clean: '开场。' },
  { id: 'e2', role: 'keeper', streaming: false, text: '[[CHECK: 聆听]]', clean: '' },
  { id: 'e3', role: 'teammate', name: '林默', text: '我不喜欢这地方。' }
]);
ok(blinking().length === 0, '读档重绘后没有光标');
ok(emptyVisibleBubbles().length === 0, '读档重绘后没有空气泡');
ok(visibleBubbles().length === 2, '两条有内容的消息可见');

// ---------------------------------------------------------------------------
console.log('\n== 检测器自检（确保上面的断言能抓到真 bug）==');
// ---------------------------------------------------------------------------
reset();
root.appendChild(new El('div'));
const fakeEmpty = new El('div');
fakeEmpty.className = 'msg keeper';
const fr = new El('div'); fr.className = 'msg-role'; fr.textContent = '守密人';
const fb = new El('div'); fb.className = 'bubble';
fakeEmpty.appendChild(fr); fakeEmpty.appendChild(fb);
root.appendChild(fakeEmpty);
ok(emptyVisibleBubbles().length === 1, '检测器能发现空的「守密人」气泡');

reset();
const fakeCursor = new El('div');
fakeCursor.className = 'msg keeper';
const cr = new El('div'); cr.className = 'msg-role'; cr.textContent = '守密人';
const cb = new El('div'); cb.className = 'bubble cursor-blink'; cb.textContent = '他擦着杯子。';
fakeCursor.appendChild(cr); fakeCursor.appendChild(cb);
root.appendChild(fakeCursor);
ok(blinking().length === 1, '检测器能发现残留的加载光标');

reset();
const hiddenEmpty = new El('div');
hiddenEmpty.className = 'msg keeper';
hiddenEmpty.hidden = true;
const hb = new El('div'); hb.className = 'bubble';
hiddenEmpty.appendChild(hb);
root.appendChild(hiddenEmpty);
ok(emptyVisibleBubbles().length === 0, '被隐藏的空气泡不误报');

console.log('\n' + '='.repeat(50));
console.log(`通过 ${passed} 项，失败 ${failed} 项，共 ${passed + failed} 项`);
if (failed) {
  console.log('失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
