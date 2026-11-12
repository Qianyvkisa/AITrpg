// ---------------------------------------------------------------------------
// 弹窗遮罩关闭行为测试
//
// 修的 bug：在设置界面按住鼠标框选文字，手滑移出弹窗、在遮罩上松开，
// 弹窗自己关掉了。根因是原实现用 click 事件 + `e.target === backdrop`
// 判断「点了遮罩空白处」——而 click 的 target 是按下与松开位置的
// **最近共同祖先**，按下在弹窗内、松开在遮罩上时，共同祖先正好是
// backdrop，于是被误判成点了空白处。
//
// 正确判据：按下和松开**都**在遮罩空白处才算真的点击。
//
// 直接 node tests/modalBackdrop.test.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DOM 桩：需要真实的事件冒泡与 target 语义，才能复现「共同祖先」这个坑
// ---------------------------------------------------------------------------
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this._innerHTML = '';
    this._handlers = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.isConnected = true;
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  remove() { this.isConnected = false; if (this.parentNode) {
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
  } }
  addEventListener(t, fn) { (this._handlers[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    const list = this._handlers[t];
    if (list) this._handlers[t] = list.filter((f) => f !== fn);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** 模拟事件冒泡：从 this 一路向上派发到根 */
  _dispatch(type, target) {
    let node = this;
    while (node) {
      for (const fn of node._handlers[type] || []) {
        fn({ type, target, preventDefault() {}, stopPropagation() {} });
      }
      node = node.parentNode;
    }
  }
}

const root = new El('div');
globalThis.document = {
  querySelector: (sel) => (sel === '#modalRoot' ? root : null),
  createElement: (tag) => new El(tag),
  createDocumentFragment: () => new El('#fragment')
};

const { openModal } = await import('../src/modals/shell.js');

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }

/** 造一个弹窗：backdrop 里包着 .modal，modal 里有内容元素 */
function makeModal() {
  root.children = [];
  const { backdrop, close } = openModal('<div class="modal"><div class="content">可选文字</div></div>');

  // 手工补出内部结构（桩的 innerHTML 不解析 HTML）
  const modal = new El('div');
  modal.className = 'modal';
  const content = new El('div');
  content.className = 'content';
  modal.appendChild(content);
  backdrop.appendChild(modal);

  return { backdrop, close, modal, content };
}

/**
 * 模拟一次完整的按下-松开。
 *
 * 关键：真实浏览器在 mouseup 之后还会补一个 click，而 **click 的 target
 * 是按下与松开位置的最近共同祖先**。这正是 bug 的成因，所以桩必须
 * 一并派发，否则测不出旧实现的问题（旧实现只听 click）。
 *
 * 这里按真实规则算共同祖先：从按下点往上找，第一个包含松开点的节点。
 */
function press(fromEl, toEl) {
  fromEl._dispatch('mousedown', fromEl);
  toEl._dispatch('mouseup', toEl);

  // 算 click 的 target：从按下点向上找第一个「松开点在其子树内」的节点
  let clickTarget = null;
  let node = fromEl;
  while (node) {
    let n = toEl;
    while (n) {
      if (n === node) { clickTarget = node; break; }
      n = n.parentNode;
    }
    if (clickTarget) break;
    node = node.parentNode;
  }

  if (clickTarget) clickTarget._dispatch('click', clickTarget);
}

// ---------------------------------------------------------------------------
console.log('\n== 核心 bug：弹窗内按下、遮罩上松开（框选拖出去）==');

{
  const { backdrop, modal } = makeModal();
  ok(backdrop.isConnected, '弹窗已打开');

  // 在弹窗里按下，拖到遮罩上松开
  press(modal, backdrop);

  ok(backdrop.isConnected, '框选拖出弹窗 → 弹窗**不**关闭（修复的关键）');
}

// ---------------------------------------------------------------------------
console.log('\n== 遮罩上按下、弹窗内松开（拖回来改主意）==');

{
  const { backdrop, modal } = makeModal();
  press(backdrop, modal);
  ok(backdrop.isConnected, '拖回弹窗内松开 → 不关闭');
}

// ---------------------------------------------------------------------------
console.log('\n== 真的点遮罩空白处：按下松开都在遮罩上 ==');

{
  const { backdrop } = makeModal();
  press(backdrop, backdrop);
  ok(!backdrop.isConnected, '点空白处 → 正常关闭');
}

// ---------------------------------------------------------------------------
console.log('\n== 弹窗内正常点击不受影响 ==');

{
  const { backdrop, content } = makeModal();
  press(content, content);
  ok(backdrop.isConnected, '在内容上按下松开 → 不关闭');
}

// ---------------------------------------------------------------------------
console.log('\n== 连续操作不会因为残留状态误判 ==');

{
  const { backdrop, modal } = makeModal();

  // 第一次：框选拖出去（不该关）
  press(modal, backdrop);
  ok(backdrop.isConnected, '第一次框选后仍开着');

  // 第二次：正常点空白（该关）
  press(backdrop, backdrop);
  ok(!backdrop.isConnected, '第二次正常点击能关闭');
}

// ---------------------------------------------------------------------------
console.log('\n== 鼠标移出窗口再回来（mouseleave 清状态）==');

{
  const { backdrop, modal } = makeModal();

  // 在弹窗内按下
  modal._dispatch('mousedown', modal);
  // 鼠标移出弹窗区域
  backdrop._dispatch('mouseleave', backdrop);
  // 然后在遮罩上松开：因为状态已清空，不应被当成点击
  backdrop._dispatch('mouseup', backdrop);

  ok(backdrop.isConnected, 'mouseleave 清掉按下状态后，孤立的 mouseup 不关闭');
}

// ---------------------------------------------------------------------------
console.log('\n== 只有 mouseup 没有 mousedown（异常序列）==');

{
  const { backdrop } = makeModal();
  backdrop._dispatch('mouseup', backdrop);
  ok(backdrop.isConnected, '没有 mousedown 的孤立 mouseup 不关闭');
}

// ---------------------------------------------------------------------------
console.log('\n== data-close 按钮仍然可用 ==');

{
  root.children = [];
  const { backdrop } = openModal('<div class="modal"></div>');
  // 桩的 querySelectorAll 返回空，这里直接验证 close 语义没被破坏
  ok(backdrop.isConnected, '弹窗打开');

  // 点空白关闭仍然有效
  press(backdrop, backdrop);
  ok(!backdrop.isConnected, 'close 仍然工作');
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
