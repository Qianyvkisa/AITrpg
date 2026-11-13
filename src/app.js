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
import { generateTeammateAction, pickActingTeammates } from './services/teammateAct.js';
import { renderAll, renderScene, resetPanelCache, applyEditingLock } from './ui/panels.js';
import {
  renderMessage,
  renderAllMessages,
  showEarlier,
  scrollToBottom,
  initMessageScroll,
  scheduleStreamUpdate,
  endStreamingBubble,
  applyCleanText,
  replaceMessage
} from './ui/messages.js';
import { openSettings, openModules, openCharEditor, openTeammateCreator, openSaves, openGameSetup, openCharLibrary } from './modals/index.js';
import { hasRunTurn, menuButtonVisibility } from './ui/menu.js';
import { buildSession } from './core/session.js';
import { createAutoAdvanceRunner } from './core/autoAdvanceRunner.js';
import { openingFor } from './core/builtinModules.js';
import { buildReplay, replayFileName } from './core/replay.js';
const $ = (sel) => document.querySelector(sel);

const state = createInitialState();

let engine = null;
let busy = false;

// ---------------------------------------------------------------------------
// 界面切换
// ---------------------------------------------------------------------------
/** 显示主界面 */
function showStartScreen() {
  // 回主界面一律**停掉**自动推进（不只是取消定时器）。
  //
  // 这里原来只调用 cancelAutoAdvance()，开关 autoAdvance 还留着 true：
  // 玩家再进一局时按钮显示「自动推进 · 开」，但定时器早没了，
  // 于是又是那个「亮着却不动」的假象。stop(null) 会同时把开关关掉，
  // 并刷新按钮外观——null 原因不产生系统提示，回主界面时不该多嘴。
  stopAutoAdvance(null);
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
  updateTokenMeter();
  scrollToBottom({ force: true });
  $('#input')?.focus();
}

// ---------------------------------------------------------------------------
// token 用量指示器
//
// 数据来源是上游每次响应自报的 usage（见 electron/llm.js 的 readStream）——
// 网关没有余额查询接口，这是唯一能拿到真实消耗的途径。
//
// 显示的是**本次会话累计**，不是账户余额：余额查不到，别假装能查。
// 用「万」为单位，避免跑几百轮后一串长数字把场景栏撑开。
// ---------------------------------------------------------------------------
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1) + 'k';
  return Math.round(v / 1000) + 'k';
}

function updateTokenMeter() {
  const el = $('#tokenMeter');
  const txt = $('#tokenText');
  if (!el || !txt) return;

  const u = engine?.usage;
  if (!u || !u.calls) {
    // 一次请求都还没成功过：不显示，免得开局就挂着个 0 让人疑惑
    el.hidden = true;
    return;
  }

  el.hidden = false;
  if (!u.total) {
    // 上游没给 usage（有些网关不支持 stream_options）：如实说未知
    txt.textContent = '用量未知';
    el.classList.remove('warn', 'high');
    el.title = '这个模型服务没有返回 token 用量，无法统计';
    return;
  }

  txt.textContent = formatTokens(u.total);

  // 分级提示：累计越多越该注意（2 万开始变黄，10 万变红）
  el.classList.toggle('warn', u.total >= 20000 && u.total < 100000);
  el.classList.toggle('high', u.total >= 100000);

  const last = u.lastTotal ? `\n上一次请求：${u.lastTotal.toLocaleString()} token` : '';
  el.title = `本次会话累计 ${u.total.toLocaleString()} token`
    + `\n输入 ${u.prompt.toLocaleString()} / 输出 ${u.completion.toLocaleString()}`
    + `\n共 ${u.calls} 次请求${last}`;
}

// ---------------------------------------------------------------------------
// 导出跑团记录（txt）
//
// 导出的是**完整精确记录**（对话、行动、投点、线索），不是给 AI 看的压缩版——
// 玩家要拿它做 replay，细节不能丢。
// ---------------------------------------------------------------------------
async function exportReplay() {
  if (!state.messages?.length) {
    alert('还没有跑团记录可以导出。');
    return;
  }

  let text;
  try {
    text = buildReplay(state);
  } catch (e) {
    console.error(e);
    alert('生成记录失败：' + e.message);
    return;
  }

  const name = replayFileName(state);

  // 优先走主进程的保存对话框；没有（比如浏览器调试）就退回下载
  const save = window.api?.saveTextFile;
  if (typeof save === 'function') {
    try {
      const res = await save({ defaultName: name, content: text });
      if (res?.ok === false && !res.canceled) alert('保存失败：' + (res.error || '未知错误'));
      return;
    } catch (e) {
      console.error(e);
      alert('保存失败：' + e.message);
      return;
    }
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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

  // 「自动推进」按钮只在旁观模式下出现：
  // 玩家模式必须等玩家输入行动，自动推进没有输入源，放出来只会让人误点。
  const autoBtn = $('#btnAutoAdvance');
  if (autoBtn) {
    autoBtn.hidden = !isSpectator;
    syncAutoAdvanceButton();
  }
}

// ---------------------------------------------------------------------------
// 旁观模式自动推进
//
// 旁观模式本来就要玩家每轮手动点「推进」，一局跑下来点上百次，纯属机械劳动。
// 这里给一个开关：打开后每轮 KP 叙述完，等一小段阅读时间就自动推进下一轮。
//
// 调度逻辑（定时器、开关、恢复）全部放在 core/autoAdvanceRunner.js 里，
// 那边可以注入假定时器，测试直接覆盖真实实现。这里只做接线：
// 把 state 与界面能力喂给调度器，再把调度器的动作暴露成界面函数。
//
// 曾经踩过的坑：调度逻辑写在 app.js 里时没法被测试直接 import，测试只能
// 照抄一份，于是「手动推进后定时器再也不重建」的 bug 一路活到了用户手里。
// ---------------------------------------------------------------------------

/** 把按钮外观同步成当前开关状态 */
function syncAutoAdvanceButton() {
  const btn = $('#btnAutoAdvance');
  if (!btn) return;
  const on = !!state.autoAdvance && state.mode === 'spectator';
  btn.classList.toggle('on', on);
  btn.textContent = on ? '自动推进 · 开' : '自动推进';
  btn.title = on
    ? '正在自动推进，点一下停止'
    : '开启后，每轮 KP 叙述完自动继续推进，不需要手动点「推进」';
}

/** 自动推进调度器（engine 尚未创建时不会被调用到，闭包里取实时值） */
const autoRunner = createAutoAdvanceRunner({
  getState: () => state,
  isBusy: () => busy,
  hasPendingRoll: () => hasPendingRoll(),
  // 跑一轮：走和手动推进完全相同的路径，只是标记来源
  runTurn: () => spectatorAdvance({ fromAuto: true }),
  notify: (text) => engine?.pushMessage({ role: 'system', text }),
  onChange: () => syncAutoAdvanceButton()
});

/** 取消挂起的自动推进（幂等） */
function cancelAutoAdvance() {
  autoRunner.cancel();
}

/** 停止自动推进，并把原因告诉玩家（避免「自动推进莫名停了」的困惑） */
function stopAutoAdvance(reason) {
  autoRunner.stop(reason);
}

/** 安排下一次自动推进 */
function scheduleAutoAdvance() {
  autoRunner.schedule();
}

/** 若自动推进开着、且当前局面可以推进，就接上 */
function resumeAutoAdvanceIfNeeded() {
  autoRunner.resume();
}

/** 切换自动推进开关 */
function toggleAutoAdvance() {
  autoRunner.toggle();
}

/** 旁观模式下「推进」：没有输入内容时给 KP 一个默认的推进指令 */
async function spectatorAdvance(opts = {}) {
  if (busy) return;

  // 手动推进时先把挂起的自动推进取消，避免紧接着又触发一次
  if (!opts.fromAuto) {
    cancelAutoAdvance();
    // 玩家亲自动手了 = 不是失控空转，连续计数清零。
    // 这样即使之前撞到 max-turns 暂停，手动推一次就能接着自动跑。
    autoRunner.resetRunCount();
  }

  const input = $('#input');
  // 玩家没输入就点「推进」时，用一句占位语催 KP 往下走。
  // 这句话**不该显示在界面上**——它不是玩家说的话，摆出来很出戏
  // （玩家会看到自己"说"了一句从没打过的话）。
  // 但它仍要作为 user 消息进上下文，否则 AI 不知道这轮该继续推进。
  const typed = input.value.trim();
  const text = typed || '（继续推进剧情，让调查员们继续行动）';
  // 只有程序补的占位语才隐藏；玩家自己打了字就正常显示
  const hiddenPlaceholder = !typed;
  input.value = '';
  input.style.height = 'auto';

  busy = true;
  const btn = $('#btnSend');
  btn.disabled = true;
  // 这一轮是否失败。失败时 finally 里不能无条件 resume：
  //   - 可恢复故障：recoverAfterFailure 已经排好退避定时器，resume 会被
  //     它的幂等保护挡住，无害；但配置错误时定时器已被取消，resume 会
  //     立刻按正常间隔（2s）重排，把「暂停等玩家」变成无限重试。
  let failed = false;
  try {
    const res = await engine.takeTurn(text, { hidden: hiddenPlaceholder });
    // 只有这一轮真的跑成了才计轮数。KP 连不上时不计，否则轮数会虚增，
    // 而且自动推进会拿着「成功」的信号继续往下跑。
    if (res?.ok === false) {
      // 失败时**不关开关**。
      //
      // 原来这里是 stopAutoAdvance(null)，结果是上游网关抖一下（502）就让
      // 自动推进永久停止，玩家得手动重新开启——而 502 往往几秒后就自己好了。
      //
      // 现在进一步区分故障性质（见 autoAdvanceRunner.recoverAfterFailure）：
      //   可恢复（502/网络抖动/超时）→ 退避后自动重试，不需要玩家插手
      //   配置错误（401/404/缺 Key）  → 立刻暂停并说清要改哪里
      //
      // 这样「自动推进」在网关抖动时真的能自己挺过去，而不是退化成
      // 「每次抖动都要我手动点一下」。
      const friendly = res.error || '模型服务暂时不可用';
      failed = true;
      autoRunner.recoverAfterFailure(friendly);
      return;
    }
    // 这一轮成功：清零失败计数，下次故障重新有完整的重试预算
    autoRunner.noteSuccess();
    state.turns = (state.turns || 0) + 1;
    await autoSave();
  } catch (e) {
    console.error(e);
    engine.pushMessage({ role: 'system', text: `【错误】${e.message}` });
    // 异常同样走恢复流程：网络类异常能自动重试，别的就暂停等玩家。
    failed = true;
    autoRunner.recoverAfterFailure(e?.message || String(e));
  } finally {
    btn.disabled = false;
    busy = false;
    updateRollGate();
    // 每轮结束刷新 token 指示器：引擎在 runKeeper 里累计了本次请求的用量
    updateTokenMeter();
    // 这一轮若产生了待掷骰，自动推进要**暂停**（不是关闭）：
    // 开关保持开着，玩家掷完骰后 resumeAutoAdvanceIfNeeded 会把它接上。
    // 这里只给一句提示，让玩家知道在等自己掷骰。
    if (opts.fromAuto && hasPendingRoll()) {
      cancelAutoAdvance();
      engine?.pushMessage({
        role: 'system',
        text: '【自动推进已暂停】有检定等你掷骰，掷完会自动继续。'
      });
    } else if (!failed) {
      // 关键：每轮结束后统一在这里重新接上自动推进。
      //
      // 这里原来**只有**上面那个 pending-roll 分支，于是手动点「推进」时
      // （spectatorAdvance 开头 cancelAutoAdvance 把定时器清掉）就再也没人
      // 重建定时器——开关亮着、按钮显示「自动推进 · 开」，却一动不动，
      // 玩家只能一直手点。这是「自动推进没效果」的真正原因。
      //
      // 放在 finally 末尾、且不区分 fromAuto，是为了让两条路径都收敛到这里：
      //   - 自动推进跑完一轮 → 继续下一轮
      //   - 玩家手动点了一轮   → 之后自动接管
      // resumeAutoAdvanceIfNeeded 自带幂等保护（开关关着/定时器已在跑/
      // 被 busy 或 pending-roll 挡住都直接返回），重复调用是安全的。
      //
      // 失败时**跳过**：定时器该由 recoverAfterFailure 决定（退避重试
      // 或彻底暂停），这里无条件 resume 会把退避覆盖成 2 秒、把暂停
      // 变成无限重试。
      resumeAutoAdvanceIfNeeded();
    }
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

/**
 * 找流式中的那条消息。
 *
 * 流式 chunk 一秒能来几十次，而 state.messages 在长局里上万条。
 * 用 find() 每次都从头线性扫描，纯属浪费——流式消息永远是最后一条
 * （偶尔是倒数几条），从末尾往前找几步就命中了。
 */
function findStreamingMessage(id) {
  const list = state.messages;
  if (!Array.isArray(list) || !list.length) return null;

  // 从末尾往前看几条：流式消息一定在尾部（可能被队友行动等消息挤后几位）
  const from = Math.max(0, list.length - 8);
  for (let i = list.length - 1; i >= from; i--) {
    if (list[i]?.id === id) return list[i];
  }

  // 极少数情况（比如读档后重放）不在尾部，才退回全量查找
  return list.find((m) => m.id === id) || null;
}

function handleEngineEvent(ev) {
  switch (ev.type) {
    case 'message':
      renderMessage(ev.message);
      scrollToBottom();
      break;

    case 'stream-chunk': {
      // 合帧渲染：chunk 再密也只在每帧写一次 DOM
      const msg = findStreamingMessage(ev.messageId);
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
    // 掷骰完成后如果自动推进还开着，把被 pending-roll 挡住的推进接上。
    // 放在这里（而不是 updateRollGate 里）是因为 updateRollGate 在进游戏、
    // 开局等场合也会被调用，在那里调度会导致定时器被反复重置。
    resumeAutoAdvanceIfNeeded();
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
  // 队友自主行动：引擎决定「什么时候编排」，这里提供「谁要行动、行动内容」
  engine.setTeammateActor(() => planTeammateActions());

  // 上游网关抖动时主进程会自动重试（502/503/504 等），这里给玩家一句提示。
  // 没有这个的话，重试期间界面完全没反应，玩家会以为程序卡死了。
  window.api.onRetry?.(({ attempt, maxRetries }) => {
    engine?.pushMessage({
      role: 'system',
      text: `【连接不稳定】模型服务暂时没响应，正在自动重试（${attempt}/${maxRetries}）…`
    });
  });

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
  $('#menuChars').onclick = () => openCharLibrary({ state, api: window.api });
  $('#menuModules').onclick = () => openModules(state, () => renderAll(state, panelHandlers));
  $('#menuRuleBook').onclick = async () => {
    // window.api 只在 Electron 里存在；浏览器里跑验证页时如实提示，不抛红字
    if (!window.api || !window.api.openRuleBook) {
      alert('规则书需要在应用内打开。');
      return;
    }
    const r = await window.api.openRuleBook();
    if (!r || !r.ok) alert('打不开规则书：' + ((r && r.error) || '未知原因'));
  };
  $('#menuSettings').onclick = () =>
    openSettings(state, () => {
      renderAll(state, panelHandlers);
      // 主界面底部的模型信息也要跟着刷新，否则保存后仍显示旧模型
      refreshStartScreen();
    });

  // ---- 跑团界面 ----
  $('#btnBackToMenu').onclick = () => {
    if (busy) { alert('守密人正在叙述，稍等一下再回主界面。'); return; }
    // 回主界面必须停掉自动推进，否则会在后台继续发请求烧 token
    stopAutoAdvance(null);
    showStartScreen();
  };

  $('#btnSettings').onclick = () =>
    openSettings(state, () => { renderAll(state, panelHandlers); });

  $('#btnModules').onclick = () =>
    openModules(state, () => { renderAll(state, panelHandlers); });

  $('#btnSaves').onclick = openSaveDialog;

  $('#btnSend').onclick = () => (state.mode === 'spectator' ? spectatorAdvance() : sendAction());

  // 自动推进开关（只在旁观模式可见，由 applyModeToComposer 控制）
  const autoAdvanceBtn = $('#btnAutoAdvance');
  if (autoAdvanceBtn) autoAdvanceBtn.onclick = toggleAutoAdvance;

  // 导出跑团记录为 txt（做 replay 用）
  const exportBtn = $('#btnExport');
  if (exportBtn) exportBtn.onclick = exportReplay;

  // 加载更早的记录（长局只渲染最近若干条，往前翻时用）
  const earlierBtn = $('#btnEarlier');
  if (earlierBtn) earlierBtn.onclick = () => showEarlier();

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
      // 读档换掉整局状态，先停掉自动推进（stop 会同时关开关 + 刷新按钮）
      stopAutoAdvance(null);
      applySnapshot(state, data);
      state.autoAdvance = false;
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

  // 新开一局：上一局的自动推进必须停掉，别让它继续在后台跑
  stopAutoAdvance(null);

  resetGameState();
  state.mode = session.mode;
  state.module = session.module;
  state.teammates = session.teammates;
  state.companions = session.companions || [];
  state.playerChar = session.playerChar;
  state.turns = 0;
  // 自动推进默认关闭，由玩家在旁观模式里主动打开
  state.autoAdvance = false;

  addOpening(session.module, session.mode);

  enterGame();
  // 开局即落盘，这样「继续」能接着这一局（含设定与开场白）
  autoSave();
}

/** 继续：读取自动存档，接着上次跑 */
async function continueGame() {
  const auto = await window.api.readSave('auto');
  if (!auto) { alert('没有找到可继续的进度。'); refreshStartScreen(); return; }

  // 读档会换掉整局状态，先把上一局的自动推进停掉
  stopAutoAdvance(null);
  applySnapshot(state, auto);
  // 自动推进是「这一次的观看方式」，不跟着存档走：读档后一律关闭，
  // 否则玩家一读档就被自动推进带着跑，来不及看清局面。
  state.autoAdvance = false;
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
    const res = await engine.takeTurn(text);
    // KP 连不上时不计轮数：否则「第 N 轮」会虚增，读档后轮数也对不上
    if (res?.ok !== false) {
      state.turns = (state.turns || 0) + 1;
      await autoSave();
    }
  } catch (e) {
    console.error(e);
    engine.pushMessage({ role: 'system', text: `【错误】${e.message}` });
  } finally {
    btn.disabled = false;
    busy = false;
    updateTokenMeter();
  }
}

/**
 * 编排这一轮有哪些队友自主行动。
 *
 * 引擎只管「按返回的列表逐个处理」，这里负责三件事：
 *   1) 用开关 + 概率决定谁要行动（控制 API 成本）
 *   2) 逐个调用队友 AI（每人一次独立请求，队友之间才有真分歧）
 *   3) 把结果整理成引擎要的形状
 *
 * 为什么要逐个 await 而不是 Promise.all：
 * 后行动的队友应该能看到前面队友刚做了什么，才能做出「配合/反对」的反应。
 * 并发调用的话，每个队友看到的都是同一份旧局面，等于各说各话。
 */
async function planTeammateActions() {
  const acting = pickActingTeammates(state);
  if (!acting.length) return [];

  // 玩家这一轮刚说了什么：队友要能针对它做反应
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
  const playerAction = lastUser?.text || '';

  const plans = [];

  for (const char of acting) {
    // 前面的队友刚行动过，就提示这位别重复
    const lastActor = [...state.messages].reverse()
      .find((m) => m.role === 'teammate-action')?.name;

    const res = await generateTeammateAction(state, window.api, char, {
      playerAction,
      lastSpeaker: lastActor
    });

    if (!res.ok) {
      // 单个队友失败不该中断整轮：记录一条隐藏提示继续下一位
      engine.pushMessage({
        role: 'system',
        text: `【队友 AI 失败】${char.name}：${res.error}`,
        hidden: true
      });
      continue;
    }

    plans.push(res);

    // 先把行动落进消息流，后面的队友才能看到（上面 buildRecentContext 读的是 state.messages）
    engine.pushMessage({
      role: 'teammate-action',
      name: res.name,
      text: res.text
    });
  }

  // 这里返回的计划里，text 已经在上面推过消息了。
  // 为避免引擎重复推送，标记已推送，由引擎跳过推送只做结算。
  return plans.map((p) => ({ ...p, alreadyPushed: true }));
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

// ---------------------------------------------------------------------------
// 开发期测试钩子
//
// 只挂三个只读/驱动用的引用，供 tools/ui/verify-*.cjs 里的 Electron 脚本
// 断言真实界面状态（单元测试碰不到 DOM，这些脚本补那一层）。
// 不涉及任何密钥，也不改变正常运行路径：即便没人用也只是几个全局引用。
// ---------------------------------------------------------------------------
window.__cocState = state;
window.__applyModeToComposer = applyModeToComposer;
window.__toggleAutoAdvance = toggleAutoAdvance;
