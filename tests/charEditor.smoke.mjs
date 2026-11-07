// ---------------------------------------------------------------------------
// 角色卡编辑器渲染冒烟测试
// 用最小 DOM 桩执行 openCharEditor，确认各标签页能渲染、collect 能收集
// ---------------------------------------------------------------------------

// ---- 极简 DOM 桩 ----
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
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      toggle: (c, on) => { if (on) this.classList._set.add(c); else this.classList._set.delete(c); },
      contains: (c) => this.classList._set.has(c)
    };
  }
  // 关键：设置 innerHTML 时把里面的节点「解析」成可查询的桩节点
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
  get disabled() { return this._disabled || false; }
  set disabled(v) { this._disabled = v; }
}

/** 极简选择器：支持 #id、.class、[attr="v"]、[attr] 及其组合，只按已注册的节点匹配 */
function queryAll(root, sel) {
  const out = [];
  const parts = sel.trim().split(/\s+/);
  // 不支持后代组合，只处理单段或逗号
  const simple = parts[parts.length - 1];
  const candidates = [];
  const walk = (n) => { for (const c of n.children) { candidates.push(c); walk(c); } };
  walk(root);

  for (const node of candidates) {
    if (matchSimple(node, simple)) out.push(node);
  }
  return out;
}

function matchSimple(node, sel) {
  // 处理 #id
  const idM = sel.match(/#([\w-]+)/);
  if (idM && node.id !== idM[1]) return false;
  // 处理 .class
  const clsM = sel.match(/\.([\w-]+)/);
  if (clsM && !node.classList.contains(clsM[1]) && !node.className.split(/\s+/).includes(clsM[1])) return false;
  // 处理 [attr="value"] 或 [attr]
  const attrM = sel.match(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g) || [];
  for (const am of attrM) {
    const m = am.match(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/);
    const name = m[1];
    const val = m[2];
    const actual = name.startsWith('data-') ? node.dataset[name.slice(5)] : node[name];
    if (val === undefined) { if (actual === undefined) return false; }
    else if (String(actual) !== val) return false;
  }
  // 纯标签名
  if (!idM && !clsM && attrM.length === 0 && sel) {
    if (!/^[\w-]+$/.test(sel)) return true;
    if (node.tagName !== sel.toUpperCase()) return false;
  }
  return true;
}

/** 把 innerHTML 里的 id/class 元素「注册」成可查询节点（粗粒度模拟） */
function parseInto(html, container) {
  // 提取所有带 id 的元素，建造成桩节点挂到 container 下
  const idRe = /<(\w+)[^>]*\bid="([\w-]+)"[^>]*>/g;
  let m;
  while ((m = idRe.exec(html))) {
    const el = new El(m[1]);
    el.id = m[2];
    const tagStr = m[0];
    const cls = tagStr.match(/class="([^"]*)"/);
    if (cls) { el.className = cls[1]; cls[1].split(/\s+/).forEach((c) => el.classList.add(c)); }
    // data-* 属性
    const dataRe = /data-([\w-]+)="([^"]*)"/g;
    let dm;
    while ((dm = dataRe.exec(tagStr))) {
      const raw = dm[1];
      el.dataset[raw] = dm[2];
      // 真实 DOM 里 data-step-up 也能用 dataset.stepUp 访问（驼峰），
      // 桩必须同样支持，否则会跟生产代码的行为对不上
      if (raw.includes('-')) {
        const camel = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[camel] = dm[2];
      }
    }
    const typeM = tagStr.match(/type="([^"]*)"/);
    if (typeM) el.type = typeM[1];
    const valM = tagStr.match(/value="([^"]*)"/);
    if (valM) el.value = valM[1];
    container.appendChild(el);
  }
  // 带 data-attr / data-skill 等属性的 input 也要能找到
  const dataOnlyRe = /<(\w+)[^>]*\b(data-(?:attr|skill|custom|bg|w|e|s|levels|hint|wi|ei|si|tab|mode|count|act|step-up|step-down|reset-skill|skillrow|suggest|free))="([^"]*)"[^>]*>/g;
  while ((m = dataOnlyRe.exec(html))) {
    const el = new El(m[1]);
    const raw = m[2].slice(5);
    el.dataset[raw] = m[3];
    // 与真实 DOM 一致：data-step-up 也能用 dataset.stepUp 取到
    if (raw.includes('-')) {
      const camel = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      el.dataset[camel] = m[3];
    }
    const tagStr = m[0];
    const valM = tagStr.match(/value="([^"]*)"/);
    if (valM) el.value = valM[1];
    const typeM = tagStr.match(/type="([^"]*)"/);
    if (typeM) el.type = typeM[1];
    const clsM = tagStr.match(/class="([^"]*)"/);
    if (clsM) { el.className = clsM[1]; clsM[1].split(/\s+/).forEach((c) => el.classList.add(c)); }
    container.appendChild(el);
  }
  return container;
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
globalThis.alert = (m) => { globalThis.__alert = m; };
globalThis.confirm = () => true;
globalThis.prompt = () => null;

// ---- 开始测试 ----
let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }

const { createCharacter } = await import('../src/core/character.js');
const { openCharEditor } = await import('../src/modals/charEditor.js');

const ch = createCharacter({ name: '测试调查员', isPlayer: true });
ch.occupation = '记者';
ch.background.traits = '好奇心重';
ch.inventory = ['笔记本', '钢笔'];
ch.weapons = [{ name: '左轮', skill: '射击：手枪', damage: '1d10', range: '15码' }];

console.log('== 打开编辑器 ==');
openCharEditor(ch, { title: '测试角色卡', allowAIGen: false });

ok(modalRoot.children.length === 1, '弹窗已挂载');
const backdrop = modalRoot.children[0];
ok(backdrop.className.includes('modal-backdrop'), '遮罩层');

// 弹窗内容已渲染：桩只登记带 id / data-* 的节点，用这些关键节点验证
ok(backdrop.querySelector('#ceBody'), '正文容器已创建');
ok(backdrop.querySelector('#btnSaveChar'), '保存按钮已创建');

// 标签页
const tabs = backdrop.querySelectorAll('.ce-tab');
ok(tabs.length === 6, '六个标签页');

const body = backdrop.querySelector('#ceBody');
ok(body, '正文容器存在');

// 基本信息页应已渲染
const nameInput = backdrop.querySelector('#fName');
ok(nameInput, '基本信息页已渲染（找到姓名输入框）');

// 切换到属性页
const attrTab = tabs.find((t) => t.dataset.tab === 'attrs');
ok(attrTab, '找到属性标签');
attrTab.onclick();
ok(backdrop.querySelector('[data-attr="STR"]'), '属性页渲染出 STR 输入框');

// 切到技能页
const skillTab = tabs.find((t) => t.dataset.tab === 'skills');
skillTab.onclick();
ok(backdrop.querySelector('[data-skill="侦查"]'), '技能页渲染出侦查输入框');

// 技能点账目面板：本次新增，确认它出现在技能页。
//
// 这个 DOM 桩只把「带 id 的元素」建成空节点，不保留元素内部的 HTML，
// 所以这里只能验证面板节点存在、且内容非空字符串；
// 点数算得对不对由 tests/occupations.test.mjs 直接验证模块函数。
const budgetBox = backdrop.querySelector('#skBudget');
ok(budgetBox, '技能页渲染出技能点面板');

// 面板是通过字符串拼进页面的，确认拼出来的内容里有这两个词
const skillsPageHtml = body.innerHTML;
ok(skillsPageHtml.includes('职业点'), '技能页 HTML 里包含「职业点」');
ok(skillsPageHtml.includes('兴趣点'), '技能页 HTML 里包含「兴趣点」');
ok(skillsPageHtml.includes('剩'), '技能页 HTML 里包含「剩余」字样');
// 空白角色没填职业，应给出可操作的提示，而不是算出 0/0 让人困惑
// （这个测试角色填了「记者」，所以这里验证的是另一条路径：能算出具体数值）
ok(skillsPageHtml.includes('记者') || skillsPageHtml.includes('还没填职业'),
  '填了职业时显示职业信息');

// 改动技能值后面板要重算（这里只确认不报错）
const reconInp = backdrop.querySelector('[data-skill="侦查"]');
if (reconInp) {
  reconInp.value = '60';
  reconInp.oninput();
  ok(true, '改技能值后点数面板重算没有抛错');
}

// ---- 技能步进器 ----
// 每行技能除了输入框，还应该有 − / ＋ 两个按钮
const upBtn = backdrop.querySelector('[data-step-up="侦查"]');
const downBtn = backdrop.querySelector('[data-step-down="侦查"]');
ok(upBtn, '技能行渲染出加号按钮');
ok(downBtn, '技能行渲染出减号按钮');

if (upBtn && downBtn) {
  const inp = backdrop.querySelector('[data-skill="侦查"]');
  // 步进器读的是 work.skills，不是 DOM 上的 value，
  // 所以先走一遍 oninput 把值同步进去，再点按钮
  inp.value = '50';
  inp.oninput();

  upBtn.onclick({ shiftKey: false });
  ok(Number(inp.value) === 51, '点加号 +1');

  downBtn.onclick({ shiftKey: false });
  ok(Number(inp.value) === 50, '点减号 -1');

  // Shift 一次 10 点
  upBtn.onclick({ shiftKey: true });
  ok(Number(inp.value) === 60, 'Shift + 加号一次 +10');

  // 下限 0：从 0 再减不会变负
  inp.value = '0';
  inp.oninput();
  downBtn.onclick({ shiftKey: false });
  ok(Number(inp.value) === 0, '减到 0 就停住');

  // 上限 99
  inp.value = '99';
  inp.oninput();
  upBtn.onclick({ shiftKey: false });
  ok(Number(inp.value) === 99, '加到 99 就停住');
}

// ---- 重置按钮 ----
// 单个技能 ↺：退回该技能的初始值，而不是归 0
const resetBtn = backdrop.querySelector('[data-reset-skill="侦查"]');
ok(resetBtn, '技能行渲染出重置按钮');

if (resetBtn) {
  const inp = backdrop.querySelector('[data-skill="侦查"]');
  inp.value = '80';
  inp.oninput();

  resetBtn.onclick();
  // 侦查初始值是 25
  ok(Number(inp.value) === 25, `重置退回初始值 25（实际 ${inp.value}）`);
}

// 闪避的初始值由 DEX 推导（DEX/2），重置后也该是这个值
const dexReset = backdrop.querySelector('[data-reset-skill="闪避"]');
if (dexReset) {
  const dexInp = backdrop.querySelector('[data-skill="闪避"]');
  dexInp.value = '90';
  dexInp.oninput();
  dexReset.onclick();
  const dex = Number(ch.attrs.DEX);
  ok(Number(dexInp.value) === Math.floor(dex / 2),
    `闪避重置回 DEX/2=${Math.floor(dex / 2)}（实际 ${dexInp.value}）`);
}

// 「全部重置」按钮存在，且能把所有技能退回初始值
const resetAllBtn = backdrop.querySelector('#btnResetAllSkills');
ok(resetAllBtn, '技能页有「全部重置」按钮');

if (resetAllBtn) {
  // 先把几个技能改乱
  for (const [name, v] of [['侦查', '77'], ['聆听', '66'], ['图书馆使用', '88']]) {
    const i = backdrop.querySelector(`[data-skill="${name}"]`);
    if (i) { i.value = v; i.oninput(); }
  }
  resetAllBtn.onclick();

  const after = (n) => Number(backdrop.querySelector(`[data-skill="${n}"]`).value);
  ok(after('侦查') === 25, `全部重置后侦查回 25（实际 ${after('侦查')}）`);
  ok(after('聆听') === 20, `全部重置后聆听回 20（实际 ${after('聆听')}）`);
  ok(after('图书馆使用') === 20, `全部重置后图书馆使用回 20（实际 ${after('图书馆使用')}）`);
}

// 克苏鲁神话不该有重置按钮（这一行是只读的）
ok(!backdrop.querySelector('[data-reset-skill="克苏鲁神话"]'), '克苏鲁神话没有重置按钮');

// ---- 克苏鲁神话锁定 ----
// 原版规则不给加点：这一行不该有输入框和步进按钮，只有只读文本
const mythosRow = backdrop.querySelector('[data-skillrow="克苏鲁神话"]');
ok(mythosRow, '技能表里有克苏鲁神话这一行');
ok(!backdrop.querySelector('[data-step-up="克苏鲁神话"]'), '克苏鲁神话没有加号按钮');
ok(!backdrop.querySelector('[data-step-down="克苏鲁神话"]'), '克苏鲁神话没有减号按钮');

const mythosInput = backdrop.querySelector('[data-skill="克苏鲁神话"]');
ok(mythosInput, '克苏鲁神话有值节点');
ok(mythosInput && mythosInput.tagName !== 'INPUT', '克苏鲁神话的值不是可编辑输入框');
ok(skillsPageHtml.includes('不可加点'), '页面上明确标注不可加点');

// ---- 「任意特长」开关 ----
//
// 152/225 个职业带「任意特长可选 N 项」。光靠固定本职技能点数花不完，
// 得让玩家指定哪几项算特长。这里验证技能行上确实渲染出了开关。
{
  const freeRow = backdrop.querySelector('[data-free="侦查"]');
  // 记者没有 free 名额 → 不该出现特长开关
  ok(!freeRow, '没有任意特长名额的职业不显示特长开关');
}

// 换一个带 free 的职业（贵族：free 3）再看。
//
// 注意：这个 DOM 桩不保留 innerHTML，切页后 #fOcc 拿不到，
// 所以没法走「在基本信息页改职业」的路径。直接重开一个编辑器，
// 用一张职业已经是贵族的卡来验证渲染。
{
  const { findOccupation } = await import('../src/core/occupations.js');
  const noble = findOccupation('贵族');
  ok((noble?.free || 0) > 0, '贵族职业带任意特长名额');

  const nobleCh = createCharacter({ name: '贵族调查员', isPlayer: true });
  nobleCh.occupation = '贵族';

  modalRoot.children.length = 0;   // 清掉上一个弹窗
  openCharEditor(nobleCh, { title: '特长测试', allowAIGen: false });
  const nb = modalRoot.children[0];
  const nTabs = nb.querySelectorAll('.ce-tab');
  const nSkillTab = nTabs.find((t) => t.dataset.tab === 'skills');
  nSkillTab.onclick();

  const freeBtn = nb.querySelector('[data-free="侦查"]');
  ok(freeBtn, '带任意特长名额的职业显示特长开关');

  // 点一下：该项应被标成「特长」，且账目里的特长计数跟着变。
  //
  // 编辑器改的是内部副本 work（取消时不污染原卡），所以这里不能断言
  // nobleCh 被改了——要断言 UI 的反应：按钮变成选中态。
  if (freeBtn) {
    freeBtn.onclick();
    const afterBtn = nb.querySelector('[data-free="侦查"]');
    ok(afterBtn && afterBtn.className.includes('is-on'),
      '点了特长开关后按钮变成选中态');
  }
}

// 切到背景页
const bgTab = tabs.find((t) => t.dataset.tab === 'bg');
bgTab.onclick();
ok(backdrop.querySelector('[data-bg="traits"]'), '背景页渲染出特质输入框');

// 切到装备页
const gearTab = tabs.find((t) => t.dataset.tab === 'gear');
gearTab.onclick();
ok(backdrop.querySelector('#fInventory'), '装备页渲染出随身物品框');

console.log('\n== 设定界面角色卡列表 ==');
globalThis.window.api = {
  listModules: async () => [],
  readSave: async () => null,
  writeSave: async () => true
};
const { openGameSetup } = await import('../src/modals/gameSetup.js');

// 清空弹窗
modalRoot.children = [];

const started = [];
await openGameSetup({ onStart: (cfg) => started.push(cfg), state: { apiConfig: {}, teammates: [], tone: '经典恐怖' }, api: {} });

ok(modalRoot.children.length === 1, '设定界面已打开');
const setup = modalRoot.children[0];
ok(setup.querySelector('#charCardList'), '角色卡列表容器存在');
ok(setup.querySelector('#btnBeginGame'), '开始游戏按钮存在');

// 默认应选中「自由创作」（moduleId = null），保证不再出现旧宅开场白
const freeRow = setup.querySelectorAll('.setup-mod-row').find((r) => r.dataset.modId === '');
ok(freeRow, '存在自由创作选项');
ok(freeRow.className.includes('on'), '自由创作默认选中');

// 角色卡行：默认 1 位玩家 + 1 位队友
const charRows = setup.querySelectorAll('.char-row');
ok(charRows.length >= 2, '玩家与队友各有一行角色卡');

// ---- 模组简介面板 ----
const brief = setup.querySelector('#setupBrief');
ok(brief, '模组简介容器存在');

// 默认（自由创作）应显示自由创作的简介
ok(brief.innerHTML.includes('自由创作'), '默认显示自由创作的简介');
ok(brief.innerHTML.includes('车卡建议') === false, '自由创作不显示车卡建议块');

// 点内置模组，简介切到该模组
const builtinRow = setup.querySelectorAll('.setup-mod-row').find((r) => r.dataset.modId === 'builtin-old-house');
ok(builtinRow, '存在内置模组选项');
builtinRow.onclick();
ok(brief.innerHTML.includes('旧宅疑影'), '选中内置模组后简介显示标题');
ok(brief.innerHTML.includes('1920'), '简介显示时代');
ok(brief.innerHTML.includes('车卡建议'), '简介显示车卡建议');

// 简介绝不能剧透：真相 / 怪物 / 结局 / NPC 秘密都不能出现
const leakWords = ['黄衣之王', '回声', '封印', '真相', '终局', '阁楼', '玛莎', '汤姆', '火漆印'];
for (const w of leakWords) {
  ok(!brief.innerHTML.includes(w), `设定界面简介不剧透「${w}」`);
}
ok(!brief.innerHTML.includes('神话'), '设定界面简介不出现「神话」字样');

// 切回自由创作，简介也要跟着回去
const freeRow2 = setup.querySelectorAll('.setup-mod-row').find((r) => r.dataset.modId === '');
freeRow2.onclick();
ok(brief.innerHTML.includes('自由创作'), '切回自由创作时简介同步更新');

// 点「开始游戏」，确认 cfg 带出角色卡
setup.querySelector('#btnBeginGame').onclick();
ok(started.length === 1, 'onStart 被调用');
const cfg = started[0];
ok(cfg.mode === 'player', '模式为 player');
ok(cfg.module === null, '默认无模组（自由创作）');
ok(cfg.playerChar && cfg.playerChar.name, 'cfg 带出玩家角色卡');
ok(Array.isArray(cfg.teammates) && cfg.teammates.length >= 1, 'cfg 带出队友角色卡');

console.log('\n== 游戏内编辑：神话值不能被清零 ==');
// 游戏进行中也能从侧边面板打开编辑器（旧签名带 state）。
// 那时克苏鲁神话是玩家靠遭遇攒下来的，保存时绝不能归零。
modalRoot.children = [];

const inGame = createCharacter({ name: '老调查员', isPlayer: true });
inGame.occupation = '记者';
// 模拟已经见过一些不该见的东西
inGame.skills['克苏鲁神话'] = 23;

const fakeState = { playerChar: inGame, teammates: [], log: [], apiConfig: {} };
openCharEditor(fakeState, inGame, () => {});

const inGameBackdrop = modalRoot.children[0];
ok(inGameBackdrop, '游戏内编辑器已打开');

// 默认停在基本信息页，先切到技能页
const inGameTabs = inGameBackdrop.querySelectorAll('.ce-tab');
const inGameSkillTab = inGameTabs.find((t) => t.dataset.tab === 'skills');
ok(inGameSkillTab, '游戏内编辑器有技能页');
inGameSkillTab.onclick();

// 游戏内这一行必须是可编辑的，否则玩家没法结算遭遇带来的增长
const inGameMythosRow = inGameBackdrop.querySelector('[data-skillrow="克苏鲁神话"]');
ok(inGameMythosRow, '游戏内也能看到克苏鲁神话行');
ok(!!inGameBackdrop.querySelector('[data-step-up="克苏鲁神话"]'),
  '游戏内克苏鲁神话可以加点（遭遇会涨神话值）');

// 保存后值必须原样保留
inGameBackdrop.querySelector('#btnSaveChar').onclick();
ok(inGame.skills['克苏鲁神话'] === 23,
  `游戏内保存后神话值保留（实际 ${inGame.skills['克苏鲁神话']}）`);

// 再验证车卡阶段仍然归零
modalRoot.children = [];
const freshCh = createCharacter({ name: '新人', isPlayer: true });
freshCh.occupation = '记者';
freshCh.skills['克苏鲁神话'] = 15;   // 故意塞个脏值
openCharEditor(freshCh, { title: '车卡', allowAIGen: false });
const freshBackdrop = modalRoot.children[0];
freshBackdrop.querySelector('#btnSaveChar').onclick();
ok(freshCh.skills['克苏鲁神话'] === 0,
  `车卡阶段保存时神话值归零（实际 ${freshCh.skills['克苏鲁神话']}）`);

console.log('\n' + '='.repeat(40));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) { for (const f of failures) console.log(' - ' + f); process.exit(1); }
console.log('全部通过');
