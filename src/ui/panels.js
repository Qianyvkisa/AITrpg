// ---------------------------------------------------------------------------
// 侧边面板渲染：角色卡 / 队友 / 状态 / 线索 / 日志 / 场景栏
// 全部是「读 state → 写 DOM」的纯函数，不含交互与请求逻辑
//
// 性能要点：每个面板都先算出 HTML 字符串，和上一次的结果比对，
// 相同就整段跳过 DOM 写入。一局游戏里 state-changed 会频繁触发，
// 而多数面板（属性、线索、日志）其实没变，全量重写 innerHTML
// 会让整页反复重排，这是界面卡顿的第二个来源。
// ---------------------------------------------------------------------------
import { ATTRS } from '../core/character.js';
import { escapeHtml } from '../shared/text.js';

const $ = (sel) => document.querySelector(sel);

/** 每个面板上一次写入的 HTML，用来做脏检查 */
const lastHtml = new Map();

/**
 * 只有内容变了才写 DOM。
 * @returns {boolean} 是否真的写入了
 */
function setHtml(sel, html) {
  const el = $(sel);
  if (!el) return false;
  if (lastHtml.get(sel) === html) return false;
  lastHtml.set(sel, html);
  el.innerHTML = html;
  return true;
}

/** 只有内容变了才写文本节点 */
function setText(sel, text) {
  const el = $(sel);
  if (!el) return;
  if (lastHtml.get(sel) === text) return;
  lastHtml.set(sel, text);
  el.textContent = text;
}

/** 状态条（HP / SAN / MP） */
export function barHtml(label, cur, max, cls) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  const low = cls === 'hp' ? cur / max < 0.34 : cls === 'san' ? cur / max < 0.25 : false;
  return `
    <div class="bar-row">
      <span class="bar-label">${label}</span>
      <div class="bar-track"><div class="bar-fill ${cls} ${low ? 'low' : ''}" style="width:${pct}%"></div></div>
      <span class="bar-num">${cur}/${max}</span>
    </div>`;
}

export function renderScene(state) {
  setText('#sceneName', state.scenario.scene || '尚未开始');
  const turns = state.messages.filter((m) => m.role === 'user').length;
  setText('#turnCounter', turns ? `第 ${turns} 轮` : '');
}

export function renderCharList(state) {
  const ch = state.playerChar;

  if (!ch) {
    setHtml(
      '#charList',
      state.mode === 'spectator'
        ? '<div class="empty-hint">旁观模式：你不扮演角色，由 AI 演出全部调查员</div>'
        : '<div class="empty-hint">还没有调查员，点 + 创建一个</div>'
    );
    return;
  }

  const dead = ch.hp.current <= 0;
  const changed = setHtml(
    '#charList',
    `
    <div class="char-card active${dead ? ' dead' : ''}">
      <div class="cc-name">
        ${escapeHtml(ch.name)}
        <span class="tag player">PC</span>
      </div>
      ${barHtml('HP', ch.hp.current, ch.hp.max, 'hp')}
      ${barHtml('SAN', ch.san.current, ch.san.temp, 'san')}
      ${barHtml('MP', ch.mp.current, ch.mp.max, 'mp')}
      ${ch.status.length ? `<div class="char-status">${ch.status.map((s) => `<span class="status-chip ${/疯狂/.test(s) ? 'san' : ''}">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
    </div>`
  );

  // 只在真的重绘后绑一次点击，避免每次 state-changed 都重复绑定
  if (changed) {
    const card = $('#charList')?.querySelector('.char-card');
    if (card) card.onclick = () => charEditHandler?.(ch);
  }
}

/** 角色卡点击回调，由 renderAll 注入 */
let charEditHandler = null;

export function renderTeammateList(state) {
  if (!state.teammates.length) {
    setHtml('#teammateList', '<div class="empty-hint">还没有队友，点 + 让 AI 扮演一位调查员</div>');
    return;
  }

  setHtml(
    '#teammateList',
    state.teammates
      .map(
        (t, i) => `
      <div class="teammate-card">
        <div class="tm-info">
          <div class="tm-name">${escapeHtml(t.name)}</div>
          <div class="tm-role">${escapeHtml(t.occupation || '调查员')} · HP ${t.hp.current} SAN ${t.san.current}</div>
        </div>
        <button class="icon-btn" data-tm-index="${i}" title="移除队友">×</button>
      </div>`
      )
      .join('')
  );

  // 按钮重建了，事件要重新绑（只在真的重绘时执行）
  $('#teammateList')?.querySelectorAll('[data-tm-index]').forEach((btn) => {
    btn.onclick = () => teammateRemoveHandler?.(state.teammates[Number(btn.dataset.tmIndex)]);
  });
}

/** 队友移除回调，由 renderAll 注入一次，避免每次重绘都传 handlers */
let teammateRemoveHandler = null;
export function setTeammateRemoveHandler(fn) {
  teammateRemoveHandler = fn;
}

/** 状态面板只展示常用技能，避免列表过长 */
const KEY_SKILLS = [
  '侦查', '聆听', '图书馆使用', '心理学', '话术', '说服',
  '闪避', '格斗：斗殴', '射击：手枪', '急救', '神秘学', '克苏鲁神话'
];

export function renderStatusPane(state) {
  const ch = state.playerChar;
  if (!ch) { setHtml('#statusPane', '<div class="empty-hint">无角色</div>'); return; }

  const attrItems = ATTRS.map(
    (a) => `<div class="attr-item"><span>${a.name}</span><b>${ch.attrs[a.key]}</b></div>`
  ).join('');

  const skillRows = KEY_SKILLS.filter((s) => ch.skills[s] !== undefined)
    .map((s) => {
      const v = ch.skills[s];
      return `<div class="skill-row ${v >= 50 ? 'highlight' : ''}"><span>${s}</span><b>${v}</b></div>`;
    })
    .join('');

  setHtml(
    '#statusPane',
    `
    <div class="stat-block">
      <div class="stat-title">属性</div>
      <div class="attr-grid">${attrItems}</div>
      <div class="derived-line">
        <span>DB <b>${ch.derived.db}</b></span>
        <span>体格 <b>${ch.derived.build}</b></span>
        <span>MOV <b>${ch.derived.MOV}</b></span>
        <span>幸运 <b>${ch.luck.current}</b></span>
      </div>
    </div>
    <div class="stat-block">
      <div class="stat-title">关键技能</div>
      <div class="skill-list">${skillRows}</div>
    </div>`
  );
}

export function renderClues(state) {
  if (!state.scenario.clues.length) {
    setHtml('#clueList', '<div class="empty-hint">还没有发现线索</div>');
    return;
  }
  setHtml(
    '#clueList',
    state.scenario.clues.map((c) => `<div class="clue-item">${escapeHtml(c)}</div>`).join('')
  );
}

export function renderRollLog(state) {
  const rolls = state.messages.filter((m) => m.role === 'roll').slice(-20);
  if (!rolls.length) {
    setHtml('#rollLog', '<div class="empty-hint">还没有掷骰记录</div>');
    return;
  }
  setHtml(
    '#rollLog',
    rolls
      .map((m) => {
        const t = new Date(m.ts);
        const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        const lvl = m.data?.level?.level;
        const cls = lvl === 'critical' ? 'crit' : lvl === 'fumble' ? 'fumb' : '';
        const label = m.data?.level?.label || '';
        const val = m.data?.roll?.value ?? m.data?.dmg ?? '';
        const who = escapeHtml(m.data?.who || '');
        const what = escapeHtml(m.data?.skill || m.data?.kind || '');
        return `<div class="log-row ${cls}"><span class="t">${time}</span><span>${who} ${what} ${val} ${escapeHtml(label)}</span></div>`;
      })
      .join('')
  );
}

/** 顶栏连接状态 */
export function renderConnStatus(state) {
  const el = $('#connStatus');
  if (!el) return;
  const c = state.apiConfig;
  if (!c.model) {
    el.textContent = '未配置';
    el.className = 'conn-status';
    return;
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(c.baseUrl);
  if (!c.apiKey && !isLocal) {
    el.textContent = '缺 API Key';
    el.className = 'conn-status bad';
    return;
  }
  el.textContent = c.model;
  el.className = 'conn-status ok';
}

/** 重绘所有面板（内部按内容变化跳过未变的部分） */
export function renderAll(state, handlers = {}) {
  if (handlers.onEdit) charEditHandler = handlers.onEdit;
  if (handlers.onRemove) teammateRemoveHandler = handlers.onRemove;
  renderCharList(state);
  renderTeammateList(state);
  renderStatusPane(state);
  renderClues(state);
  renderRollLog(state);
  renderScene(state);
  renderConnStatus(state);
}

/** 清空脏检查缓存（进游戏 / 读档后强制整体重画时用） */
export function resetPanelCache() {
  lastHtml.clear();
}
