// ---------------------------------------------------------------------------
// 对话消息流渲染：气泡、流式光标、滚动
//
// 性能要点（这是界面卡顿的主要来源，改动前请先读）：
//   1) 流式 chunk 一帧可能来几十次，绝不能每来一次就写 DOM。
//      统一进 scheduleStreamUpdate()，按 requestAnimationFrame 合帧，一帧只写一次。
//   2) .messages 不能开 scroll-behavior: smooth。流式时每次设置 scrollTop 都会
//      启动一段平滑动画，动画还没跑完就被下一次覆盖，表现就是滚动抖 + 整页掉帧。
//   3) 用户主动往上翻看历史时不要强行把他拽回底部（stick 判定）。
// ---------------------------------------------------------------------------
import { stripDirectivesForDisplay } from '../shared/text.js';
import { splitNarration } from '../core/protocol.js';

const ROLE_LABELS = {
  user: '你',
  keeper: '守密人',
  roll: '骰点',
  system: '系统',
  clue: '线索',
  scene: '场景',
  teammate: '队友',
  npc: 'NPC'
};

/** 距底部多少像素内算「贴着底部」，超过就算用户在翻历史 */
const STICK_THRESHOLD = 48;

let boxCache = null;
let stick = true;

function box() {
  if (boxCache && boxCache.isConnected) return boxCache;
  boxCache = document.querySelector('#messages');
  return boxCache;
}

export function findMsgEl(id) {
  return document.querySelector(`[data-msg-id="${id}"]`);
}

/**
 * 滚到底部。
 * @param {{force?: boolean}} opts force=true 时无视用户当前滚动位置（读档 / 进游戏时用）
 */
export function scrollToBottom({ force = false } = {}) {
  const m = box();
  if (!m) return;
  if (!force && !stick) return;
  m.scrollTop = m.scrollHeight;
}

/**
 * 绑定滚动监听，判断用户是不是还贴着底部。
 * 只需在 init 时调用一次。
 */
export function initMessageScroll() {
  const m = box();
  if (!m) return;
  m.addEventListener(
    'scroll',
    () => {
      stick = m.scrollHeight - m.scrollTop - m.clientHeight <= STICK_THRESHOLD;
    },
    { passive: true }
  );
}

/** 一条消息的气泡元素 */
export function renderMessage(msg) {
  if (msg.hidden) return null;

  // 流式消息登记内容，供 endStreamingBubble 做最后一次重绘
  if (msg.streaming) lastKnown.set(msg.id, msg);

  // KP 回复里可能夹着 NPC 台词（[[SAY: 名字 | 台词]]），
  // 切成「旁白 / NPC 台词」交替的多条气泡，读起来像几个人在对话，
  // 而不是 KP 一个人写满屏。
  if (msg.role === 'keeper') {
    const segs = msg.segments?.length ? msg.segments : splitNarration(msg.text || '');
    if (segs.some((s) => s.kind === 'say')) {
      return renderKeeperWithSays(msg, segs);
    }
  }

  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}`;
  // 流式消息不加入场动画：它的内容每帧都在变，动画会反复重放
  if (!msg.streaming) wrap.classList.add('enter');
  wrap.dataset.msgId = msg.id;

  // 骰点结果按成功等级着色
  if (msg.role === 'roll' && msg.data) {
    const lvl = msg.data.level?.level;
    if (lvl === 'critical') wrap.classList.add('critical');
    else if (lvl === 'fumble') wrap.classList.add('fumble');
    else if (msg.data.level?.ok) wrap.classList.add('success');
  }

  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = msg.name || ROLE_LABELS[msg.role] || msg.role;
  wrap.appendChild(roleEl);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.role === 'keeper') {
    const body = msg.clean ?? stripDirectivesForDisplay(msg.text || '');
    if (!String(body).trim()) {
      // 没有可见文字：流式期间给个占位让光标有处可闪，
      // 定稿后（纯指令回复）整条隐藏，不留「守密人」下面空空如也
      if (msg.streaming) {
        bubble.textContent = '…';
        bubble.classList.add('cursor-blink');
      } else {
        wrap.hidden = true;
      }
    } else {
      bubble.textContent = body;
      if (msg.streaming) bubble.classList.add('cursor-blink');
    }
  } else {
    bubble.textContent = msg.text || '';
  }

  wrap.appendChild(bubble);

  // 待掷骰：玩家角色自己的检定不自动掷，给一个按钮让玩家亲手掷
  if (msg.role === 'roll' && msg.data && msg.data.status === 'pending') {
    const bar = document.createElement('div');
    bar.className = 'roll-action';

    const btn = document.createElement('button');
    btn.className = 'btn roll-btn';
    btn.type = 'button';
    btn.dataset.rollId = msg.data.id;
    btn.textContent = '掷骰';

    // 显示奖励/惩罚骰信息，让玩家掷之前就知道条件
    const hint = document.createElement('span');
    hint.className = 'roll-hint';
    const bits = [];
    if (msg.data.bonus > 0) bits.push(`奖励骰 ×${msg.data.bonus}`);
    if (msg.data.penalty > 0) bits.push(`惩罚骰 ×${msg.data.penalty}`);
    hint.textContent = bits.join('　');

    bar.appendChild(btn);
    if (hint.textContent) bar.appendChild(hint);
    wrap.appendChild(bar);
  }

  box()?.appendChild(wrap);
  return wrap;
}

/**
 * 把一条带 NPC 台词的 KP 消息渲染成多条气泡。
 *
 * 每条片段一个气泡，但只有第一段带 msg-role（守密人），
 * 后面的片段用各自的说话人名字，避免满屏都是「守密人」。
 * 流式期间只有最后一段挂光标。
 */
function renderKeeperWithSays(msg, segs) {
  const anchor = document.createElement('div');
  anchor.className = 'msg-group';
  anchor.dataset.msgId = msg.id;

  const list = (segs || []).filter((s) => String(s.text || '').trim());

  // 定稿且没有任何可见文字（例如整条回复只有 [[CHECK]] 指令）：
  // 不渲染任何气泡，避免出现「守密人」下面空空如也
  if (!list.length) {
    if (!msg.streaming) {
      anchor.hidden = true;
      box()?.appendChild(anchor);
      return anchor;
    }
    list.push({ kind: 'prose', text: '…' });
  }

  list.forEach((seg, i) => {
    const wrap = document.createElement('div');
    const isNpc = seg.kind === 'say';
    wrap.className = `msg ${isNpc ? 'npc' : 'keeper'}`;
    if (!msg.streaming) wrap.classList.add('enter');
    wrap.dataset.msgId = msg.id;
    if (i > 0) wrap.dataset.sub = String(i);

    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent = isNpc ? seg.name || 'NPC' : ROLE_LABELS.keeper;
    wrap.appendChild(roleEl);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = seg.text;
    if (msg.streaming && i === list.length - 1) bubble.classList.add('cursor-blink');

    wrap.appendChild(bubble);
    anchor.appendChild(wrap);
  });

  box()?.appendChild(anchor);
  return anchor;
}

/** 清空并重建整个消息流（读档 / 进游戏时用） */
export function renderAllMessages(messages) {
  const m = box();
  if (!m) return;
  m.innerHTML = '';
  for (const msg of messages) renderMessage(msg);
  scrollToBottom({ force: true });
}

/**
 * 重绘单条消息（掷骰后把「待掷骰」卡片换成结果卡片）。
 *
 * 不能复用 applyCleanText：那条路径只在 message.clean 存在时才工作，
 * 而掷骰结果消息没有 clean 字段。这里直接整条替换 DOM，
 * 顺便保证按钮被移除、结果气泡按成功等级重新着色。
 */
export function replaceMessage(msg) {
  const el = findMsgEl(msg.id);
  if (!el) return renderMessage(msg);

  const fresh = renderMessage(msg);
  if (fresh) {
    el.replaceWith(fresh);
  } else {
    // 新版本不可见（理论上不会发生），移除旧节点避免残留按钮
    el.remove();
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// 流式渲染合帧
// ---------------------------------------------------------------------------
/** 待写入的流式消息：msgId → msg */
const pending = new Map();
/** 最近一次见到的流式消息内容，流式结束时用它做最后一次重绘 */
const lastKnown = new Map();
let rafId = 0;

/** 真正写 DOM 的那一步（一帧最多执行一次） */
function writeStreamingBubble(msg) {
  const el = findMsgEl(msg.id);
  if (!el) return;

  // 流式过程中 NPC 台词还没收尾，按当前文本重新切分并重建整组气泡。
  // 这是流式期间唯一允许重建 DOM 的地方：一条 KP 回复最多几段，
  // 且已经过 requestAnimationFrame 合帧，不会每来一个 chunk 就重建。
  const segs = splitNarration(msg.text || '');
  if (el.classList.contains('msg-group')) {
    rebuildGroup(el, segs, msg);
    return;
  }

  const bubble = el.querySelector('.bubble');
  if (!bubble) return;

  // 一旦出现 NPC 台词，就从单气泡升级成多气泡
  if (segs.some((s) => s.kind === 'say')) {
    el.classList.remove('msg');
    el.className = 'msg-group';
    el.hidden = false;
    rebuildGroup(el, segs, msg);
    return;
  }

  // 单气泡：只留可见文字
  const body = segs.map((s) => s.text).join('\n');
  bubble.textContent = body;
  el.hidden = !String(body).trim();
  bubble.classList.add('cursor-blink');
}

/**
 * 重建一个 msg-group 里的全部气泡。
 *
 * 两条铁律（改之前先看，这两条都踩过坑）：
 *   1) 空片段绝不能补成空气泡。纯指令回复（KP 只写了 [[CHECK: ...]]）切不出
 *      任何可见文字，补占位会在界面上留下「守密人」下面什么都没有。
 *   2) 光标只在流式期间加。定稿后重建若还加 cursor-blink，
 *      就会出现「对话已经结束、光标还在闪」。
 */
function rebuildGroup(group, segs, msg) {
  group.innerHTML = '';

  const list = (segs || []).filter((s) => String(s.text || '').trim());

  if (!list.length) {
    if (msg?.streaming) {
      // 流式期间给个占位，让光标有地方闪，不要显示成空白
      list.push({ kind: 'prose', text: '…' });
    } else {
      // 定稿后没有可见文字：整组隐藏，不留空气泡
      group.hidden = true;
      return;
    }
  }
  group.hidden = false;

  list.forEach((seg, i) => {
    const isNpc = seg.kind === 'say';
    const wrap = document.createElement('div');
    wrap.className = `msg ${isNpc ? 'npc' : 'keeper'}`;
    wrap.dataset.msgId = msg.id;
    if (i > 0) wrap.dataset.sub = String(i);

    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent = isNpc ? seg.name || 'NPC' : ROLE_LABELS.keeper;
    wrap.appendChild(roleEl);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = seg.text;
    if (msg?.streaming && i === list.length - 1) bubble.classList.add('cursor-blink');

    wrap.appendChild(bubble);
    group.appendChild(wrap);
  });
}

function flushPending() {
  rafId = 0;
  if (!pending.size) return;
  const items = [...pending.values()];
  pending.clear();
  for (const msg of items) writeStreamingBubble(msg);
  scrollToBottom();
}

/**
 * 请求刷新某条流式消息。同一帧内多次调用只写一次 DOM。
 * @param msg 消息对象（引擎会持续往 msg.text 追加内容）
 */
export function scheduleStreamUpdate(msg) {
  pending.set(msg.id, msg);
  lastKnown.set(msg.id, msg);
  if (rafId) return;
  rafId = requestAnimationFrame(flushPending);
}

/** 把某条消息的待写入内容立刻落盘（流式结束 / 文本更新前调用，避免旧内容覆盖新内容） */
export function flushStream(messageId) {
  if (messageId === undefined) {
    if (rafId) cancelAnimationFrame(rafId);
    flushPending();
    return;
  }
  const msg = pending.get(messageId);
  if (!msg) return;
  pending.delete(messageId);
  lastKnown.delete(messageId);
  writeStreamingBubble(msg);
}

/** 流式结束：把剩余内容落盘并去掉光标 */
export function endStreamingBubble(msgId) {
  // 先把待写内容落盘，但这里必须先清掉 pending，
  // 否则 flushStream 会走 writeStreamingBubble 又把光标加回去。
  // 直接按最终状态重绘：streaming 置 false，光标就不会再出现。
  const el = findMsgEl(msgId);
  pending.delete(msgId);

  const msg = lastKnown.get(msgId);
  if (el && msg) {
    const settled = { ...msg, streaming: false };
    if (el.classList.contains('msg-group')) {
      rebuildGroup(el, splitNarration(settled.text || ''), settled);
    } else {
      const bubble = el.querySelector('.bubble');
      if (bubble) {
        bubble.classList.remove('cursor-blink');
        bubble.textContent = splitNarration(settled.text || '').map((s) => s.text).join('\n');
      }
    }
  }

  if (!el) return;
  // 兜底：无论走哪条路径，都把光标清干净
  el.querySelectorAll('.bubble').forEach((b) => b.classList.remove('cursor-blink'));
}

/** 指令结算完成：用去掉指令的干净文本替换气泡内容 */
export function applyCleanText(message) {
  const el = findMsgEl(message.id);
  if (!el || message.clean === undefined) return;

  // 到这里流式已经结束：先清掉 pending，别让 flushStream 又挂上光标
  pending.delete(message.id);
  lastKnown.delete(message.id);

  const settled = { ...message, streaming: false };
  const segs = splitNarration(message.text || '');

  if (el.classList.contains('msg-group')) {
    rebuildGroup(el, segs, settled);
    el.querySelectorAll('.bubble').forEach((b) => b.classList.remove('cursor-blink'));
    return;
  }

  const bubble = el.querySelector('.bubble');
  if (!bubble) return;

  // 定稿后没有可见文字（纯指令回复）：整条隐藏，不留空气泡
  const body = message.clean ?? stripDirectivesForDisplay(message.text || '');
  bubble.classList.remove('cursor-blink');
  bubble.textContent = body;
  el.hidden = !String(body).trim();
}
