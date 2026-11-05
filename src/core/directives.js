// ---------------------------------------------------------------------------
// 指令处理器注册表
// 每个 [[...]] 指令对应一个处理函数，engine 只负责按类型分发
// 处理器签名：handle(ctx, directive) → 可选返回结果对象
//
// ctx 提供：state / findChar / pushMessage / roll 系列工具
// ---------------------------------------------------------------------------
import { rollD100, rollDice, successLevel, expandDb } from './dice.js';
import { difficultyToSkill, formatCheckResult, formatSanResult } from './protocol.js';
import { applySanCheck, checkInsanity } from './sanity.js';

const handlers = new Map();

function define(type, fn) {
  handlers.set(type, fn);
}

export function getHandler(type) {
  return handlers.get(type) || null;
}

export function handledTypes() {
  return [...handlers.keys()];
}

/** 取指令里指定的角色，缺省落到玩家角色 */
function targetChar(ctx, d) {
  const who = d.opts['角色'] || ctx.state.playerChar?.name;
  if (!who) return null;
  return ctx.findChar(who);
}

/**
 * 技能名归一化：把 AI 常用的简称/别名映射到角色卡里的规范技能名。
 *
 * 角色卡里「格斗」拆成「格斗：斗殴」「格斗①…」，「射击」拆成
 * 「射击：手枪」「射击①…」，AI 写 [[CHECK: 格斗]] 时若不映射，
 * 会被当成不存在的技能按 5 处理，判定严重失真。
 */
const SKILL_ALIASES = {
  格斗: '格斗：斗殴',
  斗殴: '格斗：斗殴',
  射击: '射击：手枪',
  手枪: '射击：手枪',
  火器: '射击：手枪',
  计算机: '计算机使用',
  电脑: '计算机使用',
  驾驶: '汽车驾驶',
  汽车: '汽车驾驶',
  技艺: '技艺①',
  外语: '外语①',
  科学: '科学①',
  生存: '生存①',
  学识: '学识①',
  图书馆: '图书馆使用',
  重型机械: '操作重型机械'
};

/**
 * 解析某个技能在当前角色卡上的值。
 * 依次尝试：原名 → 别名 → 自定义子技能名（玩家填的「摄影」等）→ 前缀匹配。
 * @returns {number|undefined} 找不到返回 undefined
 */
export function resolveSkillValue(ch, rawName) {
  const skills = ch?.skills;
  if (!skills) return undefined;

  const name = String(rawName || '').trim();
  if (!name) return undefined;

  // 1) 原名直接命中
  if (skills[name] !== undefined) return skills[name];

  // 2) 别名映射
  const alias = SKILL_ALIASES[name];
  if (alias && skills[alias] !== undefined) return skills[alias];

  // 3) 自定义子技能名：玩家把「技艺①」填成了「摄影」，AI 写「摄影」也要能命中
  const custom = ch.customNames || {};
  for (const [slot, customName] of Object.entries(custom)) {
    if (customName && String(customName) === name && skills[slot] !== undefined) {
      return skills[slot];
    }
    // 「技艺：摄影」这种带冒号的写法
    if (customName && name.includes(String(customName))) {
      const base = slot.replace(/[①②③]/, '');
      if (name.startsWith(base) && skills[slot] !== undefined) return skills[slot];
    }
  }

  // 4) 包含匹配：「格斗：刀」→ 找「格斗：斗殴」/「格斗①」，取最接近的一项
  //    先看技能名是否包含输入，再看输入是否包含技能名的前缀部分
  for (const key of Object.keys(skills)) {
    if (key.startsWith(name) || key.includes(name)) {
      return skills[key];
    }
  }
  // 反向：输入比技能名更具体（如「格斗：刀」对「格斗：斗殴」），
  // 按去掉冒号后缀的基名比较
  const baseName = name.split(/[：:]/)[0];
  if (baseName && baseName !== name) {
    for (const key of Object.keys(skills)) {
      if (key.startsWith(baseName)) return skills[key];
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 待掷骰队列 —— 玩家手动掷骰的支撑
//
// 设计要点：
//   1. 玩家角色的检定不立即掷骰，而是先登记成一条 pending，交给界面显示「掷骰」按钮。
//      骰点仍在 dice.js 里生成，AI 无法编造结果，只是把「什么时候掷」的决定权还给玩家。
//   2. 队友 / NPC 的检定仍然自动掷，因为它们是 AI 操控的，玩家不该替它们点按钮。
//   3. 结算逻辑抽成 rollPending()，手动掷骰和自动掷骰走同一段代码，
//      避免两套路径算出不同结果。
// ---------------------------------------------------------------------------

/** 该角色是否由玩家亲自操控 */
function isPlayerChar(ctx, ch) {
  if (!ch) return false;
  if (ch.isPlayer) return true;
  // 兜底：玩家角色对象与 state.playerChar 是同一个
  return ch === ctx.state.playerChar;
}

/**
 * 把一个检定登记为「等待玩家掷骰」。
 * @returns {object} 与原来 CHECK 返回值同形的占位结果
 */
function deferCheck(ctx, { who, skillName, difficulty, base, adjusted, bonus, penalty, reason }) {
  const pending = {
    id: 'roll-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    kind: 'check',
    who, skill: skillName, difficulty,
    baseSkill: base ?? 5, adjusted,
    bonus, penalty, reason,
    status: 'pending'
  };

  const msg = ctx.pushMessage({
    role: 'roll',
    text: `【待掷骰】${who} · ${skillName}${difficulty !== '常规' ? `（${difficulty}）` : ''}　目标值 ${adjusted}${reason ? '：' + reason : ''}`,
    data: pending
  });

  // 记录到消息上，玩家点按钮后要按这条消息回填结果
  pending.messageId = msg.id;
  return pending;
}

/**
 * 执行一条待掷骰，回填结果。
 * 手动掷骰与自动掷骰都走这里，保证两条路径结算一致。
 */
export function rollPending(ctx, pending) {
  if (!pending || pending.status !== 'pending') return null;

  const ch = ctx.findChar(pending.who);
  if (!ch) return null;

  pending.status = 'rolled';

  if (pending.kind === 'check') {
    const roll = rollD100({ bonus: pending.bonus, penalty: pending.penalty });
    const level = successLevel(roll.value, pending.adjusted);

    const r = {
      kind: 'check',
      who: pending.who, skill: pending.skill, difficulty: pending.difficulty,
      baseSkill: pending.baseSkill, adjusted: pending.adjusted,
      roll, level, reason: pending.reason,
      // 结果对象自带 status，回填到消息后界面据此判断不再显示「掷骰」按钮
      status: 'rolled'
    };
    pending.result = r;

    // 只有玩家手动掷骰才有占位消息可回填；自动掷骰时 messageId 为空
    if (pending.messageId) {
      ctx.updateMessage(pending.messageId, { text: formatCheckResult(r), data: r, pending: false });
    }
    ctx.state.scenario.events.push(
      `${pending.who} ${pending.skill}检定 → ${level.label}（${roll.value}/${pending.adjusted}）`
    );
    return r;
  }

  if (pending.kind === 'san') {
    const roll = rollD100({});
    const level = successLevel(roll.value, ch.attrs.POW);
    const sanResult = applySanCheck(ch, pending.lossExpr, roll, level);

    const r = {
      kind: 'san',
      who: pending.who, reason: pending.reason, lossExpr: pending.lossExpr,
      powRoll: roll, powLevel: level,
      status: 'rolled',
      ...sanResult
    };
    pending.result = r;

    // 自动掷骰（队友/NPC）没有占位消息，此时 messageId 为空，跳过回填
    if (pending.messageId) {
      ctx.updateMessage(pending.messageId, { text: formatSanResult(r), data: r, pending: false });
    }
    ctx.state.scenario.events.push(
      `${pending.who} 理智检定：损失 ${sanResult.loss} 点（${sanResult.before}→${sanResult.after}）`
    );

    // 疯狂状态检查
    const ins = checkInsanity(ch);
    if (ins.note) {
      ctx.pushMessage({ role: 'system', text: `【状态】${pending.who}：${ins.note}` });
    }

    // 临时疯狂 → 需要 INT 检定（7e：INT 检定失败 → 陷入疯狂发作）
    if (sanResult.needsIntCheck) {
      const intRoll = rollD100({});
      const intLevel = successLevel(intRoll.value, ch.attrs.INT);
      const bout = !intLevel.ok;

      r.intRoll = intRoll;
      r.intLevel = intLevel;
      r.boutTriggered = bout;

      if (bout) {
        if (!ch.status.includes('临时疯狂')) ch.status.push('临时疯狂');
        ctx.pushMessage({
          role: 'system',
          text: `【疯狂发作】${pending.who} 的理智遭到冲击，INT 检定失败（${intRoll.value}/${ch.attrs.INT}），陷入疯狂发作。`
        });
      } else {
        ctx.pushMessage({
          role: 'system',
          text: `【强撑】${pending.who} 勉强维持住了自我（INT 检定成功 ${intRoll.value}/${ch.attrs.INT}），但精神已受重创。`
        });
      }
    }
    return r;
  }

  return null;
}

/**
 * 决定这条指令作用在谁身上。
 *
 * 原来只认「指令里写的角色」→「玩家角色」，旁观模式下没有玩家角色，
 * 会兜底成字面量「调查员」，然后找不到这个人，检定直接失败。
 *
 * 这里按可用性依次回退：
 *   1) 指令里显式写的角色
 *   2) 玩家角色（成为调查员模式）
 *   3) 队伍里的第一位队友（旁观模式没有玩家角色，AI 常省略角色名）
 * @returns {{who: string, ch: object|null}}
 */
function pickActor(ctx, d) {
  const explicit = d.opts['角色'];
  if (explicit) {
    return { who: explicit, ch: ctx.findChar(explicit) };
  }

  const player = ctx.state.playerChar;
  if (player) return { who: player.name, ch: player };

  const firstMate = (ctx.state.teammates || [])[0];
  if (firstMate) return { who: firstMate.name, ch: firstMate };

  // 一个人都没有（理论上的空局）：保留原文兜底，由调用方决定怎么处理
  return { who: '调查员', ch: null };
}

// ---------------------------------------------------------------------------
// CHECK —— 技能检定
//
// 玩家角色：登记待掷骰，等玩家点「掷骰」按钮（见 rollPending）
// 队友 / NPC：自动掷，玩家只观看
// ---------------------------------------------------------------------------
define('CHECK', (ctx, d) => {
  const { who, ch } = pickActor(ctx, d);
  const difficulty = d.opts['难度'] || '常规';
  const skillName = d.head;

  if (!ch) {
    return { text: `【系统】找不到角色「${who}」`, kind: 'error' };
  }

  const base = resolveSkillValue(ch, skillName);
  const skillValue = base ?? 5;
  const adjusted = difficultyToSkill(skillValue, difficulty);

  const bonus = Number(d.opts['奖励'] || 0);
  const penalty = Number(d.opts['惩罚'] || 0);
  const reason = d.opts['原因'] || '';

  const params = { who, skillName, difficulty, base, adjusted, bonus, penalty, reason };

  // 缺技能提示：无论手动还是自动都要告诉玩家
  if (base === undefined) {
    ctx.pushMessage({
      role: 'system',
      text: `【提示】${who} 没有「${skillName}」这个技能，按基础值 5 处理`
    });
  }

  // 玩家角色 → 等待玩家亲自掷骰
  if (isPlayerChar(ctx, ch)) {
    return deferCheck(ctx, params);
  }

  // 队友 / NPC → 自动掷（走统一的结算函数）
  const autoPending = { kind: 'check', who, skill: skillName, difficulty, baseSkill: skillValue, adjusted, bonus, penalty, reason, status: 'pending' };
  const r = rollPending(ctx, autoPending);
  if (r) {
    ctx.pushMessage({ role: 'roll', text: formatCheckResult(r), data: r });
  }
  return r;
});

// ---------------------------------------------------------------------------
// SAN —— 理智检定
//
// 与 CHECK 同理：玩家角色由玩家亲手掷骰，队友 / NPC 自动掷。
// 结算统一走 rollPending()，保证两条路径的疯狂判定完全一致。
// ---------------------------------------------------------------------------
define('SAN', (ctx, d) => {
  const { who, ch } = pickActor(ctx, d);

  // 找不到角色要明确报错，不能静默返回 null。
  // 原来这里 return null，KP 的理智检定会「什么都没发生」地消失，
  // 玩家看不到任何提示，也不知道 SAN 没被结算。
  if (!ch) {
    return { text: `【系统】找不到角色「${who}」`, kind: 'error' };
  }

  const lossExpr = d.head;
  const reason = d.opts['原因'] || '';

  // 玩家角色 → 等待玩家亲自掷骰
  if (isPlayerChar(ctx, ch)) {
    const pending = {
      id: 'roll-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      kind: 'san',
      who, lossExpr, reason,
      status: 'pending'
    };
    const msg = ctx.pushMessage({
      role: 'roll',
      text: `【待掷骰】${who} · 理智检定　损失 ${lossExpr}${reason ? '：' + reason : ''}`,
      data: pending
    });
    pending.messageId = msg.id;
    return pending;
  }

  // 队友 / NPC → 自动掷（交给统一的结算函数）
  const pending = { kind: 'san', who, lossExpr, reason, status: 'pending' };
  const r = rollPending(ctx, pending);

  // 自动掷骰时没有对应的占位消息，这里补发结果消息
  if (r) {
    ctx.pushMessage({ role: 'roll', text: formatSanResult(r), data: r });
  }
  return r;
});

// ---------------------------------------------------------------------------
// DAMAGE —— 伤害结算（含伤害加值 db）
// ---------------------------------------------------------------------------
define('DAMAGE', (ctx, d) => {
  const who = d.opts['角色'] || ctx.state.playerChar?.name;
  const ch = targetChar(ctx, d);
  if (!ch) return null;

  const expr = expandDb(d.head, ch.derived.db);
  const rolled = rollDice(expr);
  const dmg = Math.max(0, rolled.total);
  ch.hp.current = Math.max(0, ch.hp.current - dmg);

  const r = {
    kind: 'damage',
    who, expr, rolled, dmg,
    hpAfter: ch.hp.current, hpMax: ch.hp.max
  };

  ctx.pushMessage({
    role: 'roll',
    text: `【伤害】${who} 受到 ${dmg} 点伤害（${d.head} = ${rolled.total}）→ HP ${ch.hp.current}/${ch.hp.max}`,
    data: r
  });

  // 重伤判定：单次伤害 ≥ 最大 HP 的一半
  if (dmg >= Math.floor(ch.hp.max / 2) && ch.hp.current > 0) {
    if (!ch.status.includes('重伤')) ch.status.push('重伤');
    ctx.pushMessage({ role: 'system', text: `【重伤】${who} 受到致命打击，进入重伤状态，需要急救。` });
  }
  if (ch.hp.current === 0) {
    if (!ch.status.includes('濒死')) ch.status.push('濒死');
    ctx.pushMessage({ role: 'system', text: `【濒死】${who} HP 归零，昏迷濒死。` });
  }

  return r;
});

// ---------------------------------------------------------------------------
// HP / MP —— 直接增减
// ---------------------------------------------------------------------------
function defineDelta(type, field, label) {
  define(type, (ctx, d) => {
    const who = d.opts['角色'] || ctx.state.playerChar?.name;
    const ch = targetChar(ctx, d);
    if (!ch) return null;

    const delta = parseInt(d.head, 10) || 0;
    const bar = ch[field];
    bar.current = Math.max(0, Math.min(bar.max, bar.current + delta));

    const r = { kind: type.toLowerCase(), who, delta, value: bar.current, max: bar.max };
    ctx.pushMessage({
      role: 'system',
      text: `【${label}】${who} ${delta >= 0 ? '+' : ''}${delta} → ${bar.current}/${bar.max}`
    });
    return r;
  });
}

defineDelta('HP', 'hp', 'HP');
defineDelta('MP', 'mp', 'MP');

// ---------------------------------------------------------------------------
// ITEM —— 获得 / 失去物品
// ---------------------------------------------------------------------------
define('ITEM', (ctx, d) => {
  const who = d.opts['角色'] || ctx.state.playerChar?.name;
  const ch = targetChar(ctx, d);
  if (!ch) return null;

  const gain = d.head.startsWith('+');
  const itemName = d.head.replace(/^[+-]/, '').trim();
  if (!itemName) return null;

  if (gain) {
    if (!ch.inventory.includes(itemName)) ch.inventory.push(itemName);
  } else {
    ch.inventory = ch.inventory.filter((i) => i !== itemName);
  }

  ctx.pushMessage({ role: 'system', text: `【物品】${who} ${gain ? '获得' : '失去'}「${itemName}」` });
  return { kind: 'item', who, item: itemName, gain };
});

// ---------------------------------------------------------------------------
// FLAG / CLUE —— 记录线索
// ---------------------------------------------------------------------------
function recordClue(ctx, d) {
  // 线索内容始终取 head；opts 里的「关键线索」只是分类标签
  const clue = d.head;
  if (!clue) return null;

  if (!ctx.state.scenario.clues.includes(clue)) ctx.state.scenario.clues.push(clue);
  ctx.pushMessage({ role: 'clue', text: `【线索】${clue}` });
  return { kind: 'clue', clue };
}

define('FLAG', recordClue);
define('CLUE', recordClue);

// ---------------------------------------------------------------------------
// SCENE / END —— 场景推进与收尾
// ---------------------------------------------------------------------------
define('SCENE', (ctx, d) => {
  if (!d.head) return null;
  ctx.state.scenario.scene = d.head;
  ctx.pushMessage({ role: 'scene', text: `【场景】${d.head}` });
  return { kind: 'scene', scene: d.head };
});

define('END', (ctx, d) => {
  ctx.state.scenario.ended = true;
  ctx.state.scenario.ending = d.head;
  ctx.pushMessage({ role: 'scene', text: `【模组结束】${d.head}` });
  return { kind: 'end', ending: d.head };
});

// ---------------------------------------------------------------------------
// 结果回喂：把本轮结算结果汇总成一段文字交回给 KP
// ---------------------------------------------------------------------------
export function summarizeResults(results) {
  const lines = results
    .filter(Boolean)
    .map((r) => {
      if (r.kind === 'check') return formatCheckResult(r);
      if (r.kind === 'san') return formatSanResult(r);
      if (r.kind === 'damage') return `【伤害】${r.who} 受到 ${r.dmg} 点伤害 → HP ${r.hpAfter}/${r.hpMax}`;
      return r.text || '';
    })
    .filter(Boolean);

  return lines.join('\n');
}
