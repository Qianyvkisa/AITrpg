// ---------------------------------------------------------------------------
// 联机面板 DOM 行为测试
//
// 重点回归两件事，都是实现时踩过的坑：
//   1) 监听器累积：renderHosting() 每次重画都会注册玩家变动监听，
//      而监听回调本身又调用 render()。如果注册写在 render 里，
//      进出几次之后一次事件会触发十几次重画，越用越卡。
//   2) 面板关闭必须解绑：否则关掉面板后 UDP 还在扫、事件还在往死掉的
//      DOM 上写，报 null 错。
//
// 直接 node tests/onlinePanel.dom.test.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DOM 桩：需要能「解析」innerHTML 里的 id / data-close，
// 因为面板代码靠 querySelector('#hostName') 这类选择器取元素。
// 桩只认 id 选择器、[data-close] 和少量 class 选择器——够跑通被测逻辑。
// ---------------------------------------------------------------------------
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.isConnected = true;
    this._innerHTML = '';
    this._handlers = {};
    this._byId = new Map();
    this._closeEls = [];
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.onclick = null;
  }

  get innerHTML() { return this._innerHTML; }

  /**
   * 设置 innerHTML 时，用正则把 id 和 data-close 元素「解析」出来，
   * 建成可查询的子元素表。真实浏览器做的是完整解析，这里只取面板
   * 代码真正会用到的部分。
   */
  set innerHTML(v) {
    this._innerHTML = v;
    this.children = [];
    this._byId = new Map();
    this._closeEls = [];

    // id="xxx" 或 id='xxx'
    for (const m of String(v).matchAll(/id="([^"]+)"/g)) {
      const el = new El('div');
      el.id = m[1];
      el.parentNode = this;
      this._byId.set(m[1], el);
      this.children.push(el);
    }
    // 带 data-close 的元素
    for (const m of String(v).matchAll(/<(\w+)([^>]*\bdata-close\b[^>]*)>/g)) {
      const el = new El(m[1]);
      el.parentNode = this;
      this._closeEls.push(el);
      this.children.push(el);
    }
    // data-room / data-host / data-port（房间列表按钮）
    for (const m of String(v).matchAll(/<button([^>]*\bdata-room="([^"]*)"[^>]*)>/g)) {
      const el = new El('button');
      const attrs = m[1];
      el.dataset.room = m[2];
      const host = attrs.match(/data-host="([^"]*)"/);
      const port = attrs.match(/data-port="([^"]*)"/);
      if (host) el.dataset.host = host[1];
      if (port) el.dataset.port = port[1];
      el.parentNode = this;
      this.children.push(el);
    }
  }

  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }

  remove() {
    this.isConnected = false;
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
    }
  }

  addEventListener(t, fn) { (this._handlers[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    const list = this._handlers[t];
    if (list) this._handlers[t] = list.filter((f) => f !== fn);
  }

  /**
   * 查询选择器。真实 DOM 是**递归**查整棵子树的，所以这里也必须往下找——
   * 面板的结构是 backdrop > #onlineBody > 内容，只查直接子元素会全都找不到。
   */
  querySelector(sel) {
    const self = this._querySelf(sel);
    if (self) return self;
    for (const c of this.children) {
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }

  /** 只在当前元素上匹配，不递归 */
  _querySelf(sel) {
    if (sel.startsWith('#')) return this._byId.get(sel.slice(1)) || null;
    if (sel === '[data-close]') return this._closeEls[0] || null;
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return (this.className || '').split(' ').includes(cls) ? this : null;
    }
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      if (sel === '[data-close]') {
        out.push(...node._closeEls);
      } else if (sel === '.online-room') {
        out.push(...node.children.filter((c) => c.dataset && c.dataset.room));
      }
      for (const c of node.children) walk(c);
    };
    walk(this);
    return out;
  }

  _dispatch(type, ev) {
    for (const fn of this._handlers[type] || []) fn(ev);
  }
}

const modalRoot = new El('div');

globalThis.document = {
  querySelector: (sel) => (sel === '#modalRoot' ? modalRoot : null),
  createElement: (tag) => new El(tag),
  createRange: () => ({ selectNodeContents() {} })
};
globalThis.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
// navigator 在 Node 里是只读的 getter，直接赋值会抛错，得用 defineProperty
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true
});
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

let alertMessages = [];
globalThis.alert = (m) => alertMessages.push(m);

// ---------------------------------------------------------------------------
// 假的 window.api.net：记录所有订阅，用来检查「注册了几次 / 解绑了几次」
// ---------------------------------------------------------------------------
function makeFakeNet() {
  const subs = [];          // { channel, fn, unsubbed }
  const calls = [];         // 记录被调用的方法名
  const state = {
    hosting: null,          // { roomCode, address, port, players }
    client: null,           // { roomCode, host, port, connected }
    rooms: []
  };

  const mkSub = (channel) => (fn) => {
    const rec = { channel, fn, unsubbed: false };
    subs.push(rec);
    return () => { rec.unsubbed = true; };
  };

  const net = {
    _subs: subs,
    _calls: calls,
    _state: state,

    hostStart: async (opts) => {
      calls.push(['hostStart', opts]);
      state.hosting = {
        roomCode: 'ABC123',
        address: '192.168.1.10',
        port: 8787,
        players: []
      };
      return { ok: true, ...state.hosting };
    },
    hostStop: async () => {
      calls.push(['hostStop']);
      state.hosting = null;
      return { ok: true };
    },
    hostPlayers: async () => {
      calls.push(['hostPlayers']);
      if (!state.hosting) return { ok: false, error: '没有在开房' };
      return { ok: true, ...state.hosting };
    },
    hostBroadcast: async () => ({ ok: true }),
    hostSendTo: async () => ({ ok: true }),
    hostSetChar: async () => ({ ok: true }),
    hostFindByChar: async () => ({ player: null }),

    join: async (opts) => {
      calls.push(['join', opts]);
      state.client = {
        roomCode: 'ABC123',
        host: opts.host,
        port: opts.port,
        connected: true
      };
      return { ok: true, playerId: 'p1', roomCode: 'ABC123' };
    },
    leave: async () => {
      calls.push(['leave']);
      state.client = null;
      return { ok: true };
    },
    send: async () => ({ ok: true }),
    clientStatus: async () => {
      calls.push(['clientStatus']);
      if (!state.client) return { ok: false, error: '没有加入房间' };
      return { ok: true, ...state.client };
    },

    scanStart: async () => {
      calls.push(['scanStart']);
      return { ok: true, rooms: state.rooms };
    },
    scanStop: async () => {
      calls.push(['scanStop']);
      return { ok: true };
    },
    rooms: async () => ({ ok: true, rooms: state.rooms }),
    normalizeRoomCode: async () => ({ ok: true, code: 'ABC123' }),
    localAddresses: async () => ({ ok: true, addresses: ['192.168.1.10'] }),
    shutdown: async () => ({ ok: true }),

    onPlayerJoined: mkSub('playerJoined'),
    onPlayerOffline: mkSub('playerOffline'),
    onPlayerReconnected: mkSub('playerReconnected'),
    onClaim: mkSub('claim'),
    onAction: mkSub('action'),
    onRoll: mkSub('roll'),
    onChat: mkSub('chat'),
    onReady: mkSub('ready'),
    onWelcome: mkSub('welcome'),
    onMessage: mkSub('message'),
    onServerError: mkSub('serverError'),
    onClientError: mkSub('clientError'),
    onFatal: mkSub('fatal'),
    onHostGone: mkSub('hostGone'),
    onDisconnected: mkSub('disconnected'),
    onReconnecting: mkSub('reconnecting'),
    onRooms: mkSub('rooms')
  };

  globalThis.window.api = { net };
  return net;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; failures.push(n); console.log(`  ✗ ${n}`); } }

const { openOnline } = await import('../src/modals/online.js');

// ---------------------------------------------------------------------------
(async () => {
  console.log('== 打开面板（未联机）==');
  let net = makeFakeNet();
  modalRoot.children = [];
  alertMessages = [];

  const panel = openOnline({ state: {} });
  await sleep(30);

  ok(modalRoot.children.length === 1, '面板已挂到 #modalRoot');
  const backdrop = modalRoot.children[0];
  // 面板内容写在 #onlineBody 里，断言要看 body 而不是 backdrop
  const body = backdrop.querySelector('#onlineBody');
  ok(!!body, '找到 #onlineBody');

  ok(net._calls.some((c) => c[0] === 'hostPlayers'), '打开了 hostPlayers 探测');
  ok(net._calls.some((c) => c[0] === 'clientStatus'), '打开了 clientStatus 探测');
  ok(net._calls.some((c) => c[0] === 'scanStart'), '自动开始扫描局域网');
  ok(body.innerHTML.includes('开房'), '渲染出开房卡片');
  ok(body.innerHTML.includes('加入'), '渲染出加入卡片');
  ok(body.innerHTML.includes('hostName'), '有名字输入框');

  console.log('\n== 开房后重画：监听器不能累积 ==');
  const hostBtn = backdrop.querySelector('#btnHostStart');
  ok(!!hostBtn, '找到开房按钮');

  await hostBtn.onclick();
  await sleep(30);

  const subsAfterFirst = net._subs.filter((s) => s.channel === 'playerJoined').length;
  ok(subsAfterFirst === 1, `开房后只注册 1 个 playerJoined 监听（实际 ${subsAfterFirst}）`);
  ok(body.innerHTML.includes('ABC123'), '显示房间码');
  ok(body.innerHTML.includes('192.168.1.10'), '显示局域网地址');

  // 连续触发几次玩家变动，模拟有人进出。
  // 如果监听器累积了，每触发一次就会多跑一遍 render，
  // 表现为 playerJoined 的订阅数不断上涨。
  for (let i = 0; i < 5; i++) {
    const joined = net._subs.filter((s) => s.channel === 'playerJoined' && !s.unsubbed);
    joined.forEach((s) => s.fn({ player: { id: 'p' + i, name: '玩家' + i } }));
    await sleep(10);
  }

  const subsAfterMany = net._subs.filter((s) => s.channel === 'playerJoined' && !s.unsubbed).length;
  ok(subsAfterMany === 1, `5 次事件后仍只有 1 个监听（实际 ${subsAfterMany}）`);

  console.log('\n== 关闭面板要解绑 ==');
  panel.close();
  await sleep(30);

  const liveSubs = net._subs.filter((s) => !s.unsubbed);
  ok(liveSubs.length === 0, `关闭后所有监听都已解绑（残留 ${liveSubs.length}）`);
  ok(net._calls.some((c) => c[0] === 'scanStop'), '关闭时停止了局域网扫描');
  ok(modalRoot.children.length === 0, '面板已从 DOM 移除');

  console.log('\n== 加入房间流程 ==');
  net = makeFakeNet();
  modalRoot.children = [];
  net._state.rooms = [
    { roomCode: 'XYZ789', hostName: '老王', host: '192.168.1.20', port: 8787 }
  ];

  const panel2 = openOnline({
    state: {},
    onJoined: (info) => { panel2._joined = info; }
  });
  await sleep(40);

  const backdrop2 = modalRoot.children[0];
  const body2 = backdrop2.querySelector('#onlineBody');
  // 房间列表是写进 #roomList 的，不在 body.innerHTML 里——
  // 桩的 innerHTML 不做真实解析，所以要直接查那个子元素。
  const roomListEl = body2.querySelector('#roomList');
  ok(!!roomListEl, '找到房间列表容器');
  const roomHtml = roomListEl ? roomListEl.innerHTML : '';
  ok(roomHtml.includes('XYZ789'), '扫到的房间出现在列表里');
  ok(roomHtml.includes('老王'), '显示房主名字');

  // 点房间按钮
  const roomBtns = backdrop2.querySelectorAll('.online-room');
  ok(roomBtns.length === 1, '房间按钮可点');
  await roomBtns[0].onclick();
  await sleep(40);

  const joinCall = net._calls.find((c) => c[0] === 'join');
  ok(!!joinCall, '发起了加入请求');
  ok(joinCall[1].host === '192.168.1.20', '连的是房间列表里的地址');
  ok(joinCall[1].port === 8787, '端口正确');

  // 加入成功后应显示「已加入」
  ok(body2.innerHTML.includes('已加入房间'), '加入后显示已加入状态');
  ok(net._calls.some((c) => c[0] === 'scanStop'), '加入后停止扫描');

  console.log('\n== 加入失败要提示 ==');
  net = makeFakeNet();
  modalRoot.children = [];
  alertMessages = [];
  net.join = async () => ({ ok: false, error: '连不上房主' });

  const panel3 = openOnline({ state: {} });
  await sleep(40);
  const bd3 = modalRoot.children[0];
  // 展开手动输入并填写
  const hostInput = bd3.querySelector('#joinHost');
  const portInput = bd3.querySelector('#joinPort');
  hostInput.value = '10.0.0.5';
  portInput.value = '9000';
  await bd3.querySelector('#btnJoinManual').onclick();
  await sleep(40);

  ok(alertMessages.some((m) => m.includes('连不上房主')), '加入失败时弹出错误提示');

  console.log('\n== 缺少 net 时的降级 ==');
  modalRoot.children = [];
  alertMessages = [];
  globalThis.window.api = {};
  openOnline({ state: {} });
  await sleep(20);
  ok(alertMessages.some((m) => m.includes('联机功能不可用')), '没有 net 时给出明确提示而不是崩掉');

  console.log('\n==========================================');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed === 0) console.log('全部通过');
  else {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('未捕获错误:', e);
  process.exitCode = 1;
});
