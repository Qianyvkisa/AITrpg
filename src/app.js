// ---------------------------------------------------------------------------
// 应用主入口：只负责装配 —— 建状态、连引擎、绑界面、接弹窗
// 渲染细节在 ui/，持久化在 persistence.js，AI 调用在 services/
//
// 界面分两层：
//   1) 主界面（开始界面）：开始 / 继续 / 存档 / 模组管理 / 设置
//   2) 跑团界面：进入跑团后才显示
// ---------------------------------------------------------------------------
import { GameEngine } from './core/engine.js';
import { createCharacter } from './core/character.js';
import { createInitialState, createDefaultCharacter } from './state.js';
import { buildSnapshot, applySnapshot } from './persistence.js';
import { generateTeammateLine } from './services/teammate.js';
import { renderAll, renderScene, resetPanelCache, applyEditingLock } from './ui/panels.js';
import {
  renderMessage,
  renderAllMessages,
  scrollToBottom,
  initMessageScroll,
  scheduleStreamUpdate,
  endStreamingBubble,
  applyCleanText,
  replaceMessage
} from './ui/messages.js';
import { openSettings, openModules, openCharEditor, openTeammateCreator, openSaves, openGameSetup } from './modals/index.js';
import { hasRunTurn, menuButtonVisibility } from './ui/menu.js';
import { buildSession } from './core/session.js';
import { openingFor } from './core/builtinModules.js';
const $ = (sel) => document.querySelector(sel);

const state = createInitialState();

let engine = null;
let busy = false;

// ---------------------------------------------------------------------------
// 界面切换
// ---------------------------------------------------------------------------
/** 显示主界面 */
function showStartScreen() {
  $('#startScreen').hidden = false;
  $('#app').hidden = true;
  // 回到开始界面：重新放开「加队友 / 加调查员」，这时还能调整队伍
  applyEditingLock(false);
  refreshStartScreen();
}

/** 进入跑团界面（重建消息流 + 全量重绘） */
function enterGame() {
  $('#startScreen').hidden = true;
  $('#app').hidden = false;

  // 开局后不再允许增删队友与调查员，避免破坏已跑起来的局面
  applyEditingLock(true);

  // 换了局面/读档：面板缓存要作废，否则同名角色不会重画
  resetPanelCache();
  renderAllMessages(state.messages);
  renderAll(state, panelHandlers);
  renderScene(state);
  applyModeToComposer();
  // 读档进来时可能还有没掷的骰，要把输入区锁上
  updateRollGate();
  scrollToBottom({ force: true });
  $('#input')?.focus();
}

/**
 * 按参与方式调整输入区。
 * 旁观模式没有玩家角色，让玩家输入"剧情指示"，按钮也从「行动」变成「推进」。
 */
function applyModeToComposer() {
  const input = $('#input');
  const sendBtn = $('#btnSend');
  const isSpectator = state.mode === 'spectator';

  if (input) {
    input.placeholder = isSpectator
      ? '剧情指示（留空直接推进，Enter 发送）'
      : '你要做什么？（Enter 发送，Shift+Enter 换行）';
  }
  if (sendBtn) {
    sendBtn.textContent = isSpectator ? '推进' : '行动';
  }
}

/** 旁观模式下「推进」：没有输入内容时给 KP 一个默认的推进指令 */
async function spectatorAdvance() {
  const input = $('#input');
  const text = input.value.trim() || '（继续推进剧情，让调查员们继续行动）';
  input.value = '';
  input.style.height = 'auto';

  if (busy) return;
  busy = true;
  const btn = $('#btnSend');
  btn.disabled = true;
  try {
    await engine.takeTurn(text);
    state.turns = (state.turns || 0) + 1;
    await autoSave();
  } catch (e) {
    console.error(e);
    engine.pushMessage({ role: 'system', text: `【错误】${e.message}` });
  } finally {
    btn.disabled = false;
    busy = false;
  }
}

/**
 * 刷新主界面：在「开始」与「继续」之间二选一，并显示最近存档摘要。
 * 判定标准：自动存档里存在玩家行动记录（真的跑过一轮）才算「有进度」。
 *
 * 三种按钮的组合规则：
 *   有进度  → 只显示「继续」 + 「放弃游戏」，「开始」隐藏
 *   无进度  → 只显示「开始」，「继续」与「放弃游戏」都隐藏
 */
async function refreshStartScreen() {
  // 底部显示当前模型，未配置时给出提示
  const c = state.apiConfig;
  const modelEl = $('#startModel');
  if (!c.model) {
    modelEl.textContent = '未配置模型';
    modelEl.style.color = '#c96a6a';
  } else if (!c.apiKey && !/localhost|127\.0\.0\.1/.test(c.baseUrl)) {
    modelEl.textContent = `${c.model} · 缺 API Key`;
    modelEl.style.color = '#c96a6a';
  } else {
    modelEl.textContent = c.model;
    modelEl.style.color = '';
  }

  const auto = await window.api.readSave('auto');
  const snap = auto?.state || auto;
  // 有进度才显示「继续」：仅有开场白、还没行动过的不算
  const hasProgress = hasRunTurn(snap);

  const vis = menuButtonVisibility(hasProgress);
  $('#menuStart').hidden = !vis.start;
  $('#menuContinue').hidden = !vis.cont;
  $('#menuAbandon').hidden = !vis.abandon;

  if (hasProgress) {
    const desc = $('#menuContinueDesc');
    const title = auto?.meta?.title || '自由创作';
    const scene = auto?.meta?.scene || snap?.scenario?.scene || '';
    const who = auto?.meta?.charName || snap?.playerChar?.name || '';
    const turns = auto?.meta?.turns ?? (snap?.messages || []).filter((m) => m.role === 'user').length;
    desc.textContent = [title, scene, who, turns ? `第 ${turns} 轮` : '']
      .filter(Boolean)
      .join(' · ');
  }
}

/** 原地重置状态（保留 API 配置与基调，engine 持有的引用不变） */
function resetGameState() {
  const keepApiConfig = state.apiConfig;
  const keepTone = state.tone;
  Object.assign(state, createInitialState());
  state.apiConfig = keepApiConfig;
  state.tone = keepTone;
}

// ---------------------------------------------------------------------------
// 引擎事件 → 界面
// ---------------------------------------------------------------------------
function handleEngineEvent(ev) {
  switch (ev.type) {
    case 'message':
      renderMessage(ev.message);
      scrollToBottom();
      break;

    case 'stream-chunk': {
      // 合帧渲染：chunk 再密也只在每帧写一次 DOM
      const msg = state.messages.find((m) => m.id === ev.messageId);
      if (msg) scheduleStreamUpdate(msg);
      break;
    }

    case 'stream-end':
      endStreamingBubble(ev.messageId);
      break;

    case 'message-updated':
      // 掷骰结果消息没有 clean 字段，applyCleanText 会直接跳过，
      // 这种情况走整条重绘，顺便把「掷骰」按钮移除
      if (ev.message && ev.message.clean === undefined) {
        replaceMessage(ev.message);
      } else {
        applyCleanText(ev.message);
      }
      break;

    case 'roll-pending':
      // 有玩家待掷骰：把输入框暂时锁住，提示先掷骰再继续
      updateRollGate();
      break;

    case 'state-changed':
      renderAll(state, panelHandlers);
      updateRollGate();
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 面板交互回调（面板只负责显示，动作由这里提供）
// ---------------------------------------------------------------------------
const panelHandlers = {
  onEdit: (ch) => openCharEditor(state, ch, () => renderAll(state, panelHandlers)),
  onRemove: (t) => {
    state.teammates = state.teammates.filter((x) => x.id !== t.id);
    renderAll(state, panelHandlers);
  }
};

// ---------------------------------------------------------------------------
// 待掷骰：玩家亲手掷骰
// ---------------------------------------------------------------------------

/** 当前是否有玩家待掷骰 */
function hasPendingRoll() {
  return state.messages.some(
    (m) => m.role === 'roll' && m.data && m.data.status === 'pending'
  );
}

/**
 * 有待掷骰时锁住输入区。
 * 理由：骰点还没掷出就让玩家继续行动，KP 会在下一轮基于「未发生的结果」
 * 继续叙述，故事线会和真实骰点错位。
 */
function updateRollGate() {
  const sendBtn = $('#btnSend');
  const input = $('#input');
  const pending = hasPendingRoll();
  state.awaitingRoll = pending;

  if (sendBtn) {
    sendBtn.disabled = pending || busy;
    sendBtn.textContent = pending ? '先掷骰' : (state.mode === 'spectator' ? '推进' : '行动');
  }
  if (input) {
    input.disabled = pending;
    input.placeholder = pending
      ? '请先点「掷骰」完成上面的检定…'
      : '描述你的行动…';
  }
}

/** 处理掷骰按钮点击 */
async function handleRollClick(rollId) {
  if (!rollId || busy) return;
  if (!engine) return;

  const target = engine.pendingRolls().find((p) => p.id === rollId);
  if (!target) return;

  busy = true;
  updateRollGate();

  try {
    await engine.rollAndResume(rollId);
    await autoSave();
  } catch (e) {
    console.error(e);
    engine.pushMessage({ role: 'system', text: `【掷骰失败】${e.message}` });
  } finally {
    busy = false;
    updateRollGate();
    scrollToBottom();
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  await loadConfig();

  engine = new GameEngine(state, window.api);
  engine.on(handleEngineEvent);
  // 引擎每轮结束后会让队友自发接话，具体怎么调 LLM 由这里提供
  engine.setTeammateSpeaker(() => teammateSpeak({ fromEngine: true }));

  initMessageScroll();
  bindUI();
  showStartScreen();
}

async function loadConfig() {
  const cfg = await window.api.getConfig();
  Object.assign(state.apiConfig, {
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey || '',
    model: cfg.model || '',
    temperature: cfg.temperature ?? 0.8,
    maxTokens: cfg.maxTokens ?? 2048
  });
  state.tone = cfg.tone || '经典恐怖';
}

// ---------------------------------------------------------------------------
// 界面绑定
// ---------------------------------------------------------------------------
function bindUI() {
  // ---- 主界面 ----
  $('#menuStart').onclick = startNewGame;
  $('#menuContinue').onclick = continueGame;
  $('#menuAbandon').onclick = abandonGame;
  $('#menuSaves').onclick = openSaveDialog;
  $('#menuModules').onclick = () => openModules(state, () => renderAll(state, panelHandlers));
  $('#menuSettings').onclick = () =>
    openSettings(state, () => {
      renderAll(state, panelHandlers);
      // 主界面底部的模型信息也要跟着刷新，否则保存后仍显示旧模型
      refreshStartScreen();
    });

  // ---- 跑团界面 ----
  $('#btnBackToMenu').onclick = () => {
    if (busy) { alert('守密人正在叙述，稍等一下再回主界面。'); return; }
    showStartScreen();
  };

  $('#btnSettings').onclick = () =>
    openSettings(state, () => { renderAll(state, panelHandlers); });

  $('#btnModules').onclick = () =>
    openModules(state, () => { renderAll(state, panelHandlers); });

  $('#btnSaves').onclick = openSaveDialog;

  $('#btnSend').onclick = () => (state.mode === 'spectator' ? spectatorAdvance() : sendAction());

  // 掷骰按钮：用事件委托，避免每渲染一条待掷骰消息就重新绑一次
  const messagesBox = $('#messages');
  if (messagesBox) {
    messagesBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.roll-btn');
      if (!btn) return;
      e.preventDefault();
      handleRollClick(btn.dataset.rollId);
    });
  }
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (state.mode === 'spectator') spectatorAdvance();
      else sendAction();
    }
  });

  $('#btnAuto').onclick = teammateSpeak;

  $('#btnNewChar').onclick = () => {
    // 旁观模式下新增玩家角色会与「没有玩家」的前提冲突
    if (state.mode === 'spectator') {
      alert('当前是旁观模式，你不扮演角色。\n\n想亲自操作调查员，请回主界面用「开始」重新开一局并选择「成为调查员」。');
      return;
    }
    state.playerChar = createCharacter({ name: '新调查员', isPlayer: true });
    renderAll(state, panelHandlers);
    openCharEditor(state, state.playerChar, () => renderAll(state, panelHandlers));
  };

  $('#btnAddTeammate').onclick = () =>
    openTeammateCreator(state, () => renderAll(state, panelHandlers));
}

/** 存档弹窗（主界面与跑团界面共用；读档后直接进入跑团界面） */
function openSaveDialog() {
  openSaves({
    // 还没行动过就没有进度可存，隐藏「保存当前进度」
    allowSave: hasRunTurn(state),
    getSnapshot: () => buildSnapshot(state),
    onLoad: async (data) => {
      applySnapshot(state, data);
      // 读档后立刻写回自动存档：这样「继续」与当前这一局保持一致，
      // 避免从手动存档进入游戏、回主界面后却显示「开始」而误以为进度丢了
      await autoSave();
      enterGame();
    }
  });
}

// ---------------------------------------------------------------------------
// 开始 / 继续
// ---------------------------------------------------------------------------
/**
 * 开始：先打开「游戏设定界面」，确认参与方式 / 模组 / 队友数，再正式开局。
 * 直接进游戏的旧行为已移除。
 */
async function startNewGame() {
  const auto = await window.api.readSave('auto');
  const snap = auto?.state || auto;
  if (hasRunTurn(snap)) {
    const ok = confirm('「开始」会开启一段全新的调查，当前进度（自动存档）将被覆盖。\n\n如果想保留，请先取消并到「存档」里手动保存一份。\n\n确定开始新团吗？');
    if (!ok) return;
  }

  // 进设定界面；用户点「取消」则什么都不做
  await openGameSetup({ onStart: (cfg) => beginGame(cfg), state, api: window.api });
}

/** 按设定界面的选择正式开局 */
function beginGame(cfg) {
  // 设定界面已经车好的角色卡随 cfg 一起传进来
  const session = buildSession(cfg);

  resetGameState();
  state.mode = session.mode;
  state.module = session.module;
  state.teammates = session.teammates;
  state.playerChar = session.playerChar;
  state.turns = 0;

  addOpening(session.module, session.mode);

  enterGame();
  // 开局即落盘，这样「继续」能接着这一局（含设定与开场白）
  autoSave();
}

/** 继续：读取自动存档，接着上次跑 */
async function continueGame() {
  const auto = await window.api.readSave('auto');
  if (!auto) { alert('没有找到可继续的进度。'); refreshStartScreen(); return; }

  applySnapshot(state, auto);
  // 旁观模式本来就没有玩家角色，不要凭空补一个
  if (!state.playerChar && state.mode !== 'spectator') state.playerChar = createDefaultCharacter();
  enterGame();
}

/**
 * 放弃游戏：清掉当前进度（自动存档 + 内存状态），回到「开始」状态。
 * 手动存档不动，用户仍可从「存档」里读回来。
 */
async function abandonGame() {
  const ok = confirm(
    '确定放弃当前进度吗？\n\n' +
    '这会清除自动存档，回到「开始」状态。\n' +
    '如果你之前手动保存过，那些存档不会被删除，之后仍可从「存档」里读回来。'
  );
  if (!ok) return;

  await window.api.deleteSave('auto');
  resetGameState();
  refreshStartScreen();
}

// ---------------------------------------------------------------------------
// 玩家行动
// ---------------------------------------------------------------------------
async function sendAction() {
  if (busy) return;

  // 有未掷的骰：先掷完再继续行动，否则 KP 会基于未定的结果往下叙述
  if (hasPendingRoll()) {
    alert('请先点消息里的「掷骰」按钮，把这次检定掷完。');
    return;
  }

  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;

  // 旁观模式没有玩家角色，玩家输入的是"旁白/指令"而不是角色行动
  if (!state.playerChar && state.mode !== 'spectator') {
    alert('请先创建调查员');
    return;
  }

  input.value = '';
  input.style.height = 'auto';

  busy = true;
  const btn = $('#btnSend');
  btn.disabled = true;

  try {
    // 引擎内部处理「掷骰后自动续跑」，并带次数上限
    await engine.takeTurn(text);
    state.turns = (state.turns || 0) + 1;
    await autoSave();
  } catch (e) {
    console.error(e);
    engine.pushMessage({ role: 'system', text: `【错误】${e.message}` });
  } finally {
    btn.disabled = false;
    busy = false;
  }
}

/** 队友 AI 主动插话 */
async function teammateSpeak(opts = {}) {
  if (busy && !opts.fromEngine) return;

  if (!state.teammates.length) {
    if (!opts.fromEngine) alert('还没有队友。点左侧「队友 +」添加一位。');
    return;
  }

  const res = await generateTeammateLine(state, window.api);
  if (!res.ok) {
    // 自动插话失败时不打扰玩家，只在手动模式下提示
    if (!opts.fromEngine) {
      engine.pushMessage({ role: 'system', text: `【队友 AI 失败】${res.error}` });
    }
    return;
  }

  engine.pushMessage({ role: 'teammate', name: res.name, text: res.text });
  scrollToBottom();
  await autoSave();
}

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------
async function autoSave() {
  await window.api.writeSave('auto', buildSnapshot(state));
}

// ---------------------------------------------------------------------------
// 开场白
// ---------------------------------------------------------------------------
/**
 * 写入开场白。
 * 文案来自模组本身（内置模组各有一套），没有模组时用自由创作的开场。
 * @param module 选中的模组
 * @param mode 'player' | 'spectator'
 */
function addOpening(module, mode = 'player') {
  const intro = openingFor(module, mode);

  const w = { id: 'welcome', role: 'keeper', text: intro, clean: intro };
  state.messages.push(w);

  state.scenario.scene = module?.scene || '未知之处';
  state.scenario.events.push(
    module ? `开场：进入《${module.title}》` : '开场：自由创作'
  );
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', init);
