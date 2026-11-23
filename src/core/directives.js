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
import { ATTRS } from './character.js';
import { applyDamage, incapacity, markDead, recoverHp } from './vitals.js';

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
  const name = String(rawName || '').trim();
  if (!name) return undefined;
  if (name === '幸运' || name.toUpperCase() === 'LUCK') return ch?.luck?.current;
  const attribute = ATTRS.find(({ key, name: label }) => key === name.toUpperCase() || label === name);
  if (attribute) return ch?.attrs?.[attribute.key];
  const skills = ch?.skills;
  if (!skills) return undefined;

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
  if (ctx.rollOwner?.(ch)) return true;
  if (ch.isPlayer) return true;
  // 兜底：玩家角色对象与 state.playerChar 是同一个
  return ch === ctx.state.playerChar;
}

/**
 * 把一个检定登记为「等待玩家掷骰」。
 * @returns {object} 与原来 CHECK 返回值同形的占位结果
 */
function deferCheck(ctx, params) {
  const { who, skill, difficulty, adjusted, reason } = params;
  const pending = {
    ...params,
    id: 'roll-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
  };

  const msg = ctx.pushMessage({
    role: 'roll',
    text: `【待掷骰】${who} · ${skill}${difficulty !== '常规' ? `（${difficulty}）` : ''}　目标值 ${adjusted}${reason ? '：' + reason : ''}`,
    data: pending
  });

  // 记录到消息上，玩家点按钮后要按这条消息回填结果
  pending.messageId = msg.id;
  return pending;
}

function requestCheck(ctx, ch, { skill, baseSkill, difficulty = '常规', bonus = 0, penalty = 0, reason = '', effect }) {
  const pending = {
    kind: 'check', who: ch.name, charId: ch.id, skill, baseSkill, difficulty,
    adjusted: difficultyToSkill(baseSkill, difficulty), bonus, penalty, reason, effect,
    status: 'pending', ownerId: ctx.rollOwner?.(ch)
  };
  if (isPlayerChar(ctx, ch)) return deferCheck(ctx, pending);
  const result = rollPending(ctx, pending);
  if (result) ctx.pushMessage({ role: 'roll', text: result.text || formatCheckResult(result), data: result });
  return result;
}

export function pendingCharacter(ctx, roll) {
  if (roll.charId && ctx.findCharById) return ctx.findCharById(roll.charId);
  return ctx.findChar(roll.who);
}

export function rollBlocker(character, roll) {
  if (!character) return '角色已不在调查队';
  const condition = incapacity(character);
  if (roll.effect === 'dying') return condition === '濒死' ? '' : '已无需濒死检定';
  return condition ? `角色处于${condition}状态` : '';
}

export function waitsForWoundCheck(roll, pending) {
  return !roll.effect && pending.some((other) => other.effect === 'major-wound' &&
    (roll.charId && other.charId ? roll.charId === other.charId : roll.who === other.who));
}

export function cancelPendingRoll(ctx, roll, reason) {
  roll.status = 'cancelled';
  roll.text = `【检定取消】${roll.who} · ${roll.skill || '理智检定'}（${reason}）`;
  if (roll.messageId) ctx.updateMessage(roll.messageId, { text: roll.text, data: roll, pending: false });
  return roll;
}

/**
 * 执行一条待掷骰，回填结果。
 * 手动掷骰与自动掷骰都走这里，保证两条路径结算一致。
 */
export function rollPending(ctx, pending) {
  if (!pending || pending.status !== 'pending') return null;

  const ch = pendingCharacter(ctx, pending);
  const blocked = rollBlocker(ch, pending);
  if (blocked) return cancelPendingRoll(ctx, pending, blocked);

  pending.status = 'rolled';

  if (pending.kind === 'check') {
    const roll = rollD100({ bonus: pending.bonus, penalty: pending.penalty });
    const level = successLevel(roll.value, pending.baseSkill, pending.adjusted);
    const passed = level.ok && (level.level === 'critical' || roll.value <= pending.adjusted);

    const r = {
      kind: 'check',
      who: pending.who, charId: pending.charId, skill: pending.skill, difficulty: pending.difficulty,
      baseSkill: pending.baseSkill, adjusted: pending.adjusted,
      roll, level, passed, reason: pending.reason,
      // 结果对象自带 status，回填到消息后界面据此判断不再显示「掷骰」按钮
      status: 'rolled'
    };
    if (!passed && pending.effect === 'major-wound') {
      const status = ch.status ??= [];
      if (!status.includes('昏迷')) status.push('昏迷');
      r.outcome = '重伤体质检定失败，陷入昏迷。';
    } else if (!passed && pending.effect === 'dying') {
      markDead(ch);
      r.outcome = '濒死体质检定失败，角色死亡。';
    }
    pending.result = r;

    // 只有玩家手动掷骰才有占位消息可回填；自动掷骰时 messageId 为空
    if (pending.messageId) {
      ctx.updateMessage(pending.messageId, { text: formatCheckResult(r), data: r, pending: false });
    }
    ctx.state.scenario.events.push(
      `${pending.who} ${pending.skill}检定 → ${passed ? level.label : '未通过'}（${roll.value}/${pending.adjusted}）`
    );
    return r;
  }

  if (pending.kind === 'san') {
    const roll = rollD100({});
    const level = successLevel(roll.value, ch.san.current);
    const sanResult = applySanCheck(ch, pending.lossExpr, roll, level);

    const r = {
      kind: 'san',
      who: pending.who, charId: pending.charId, reason: pending.reason, lossExpr: pending.lossExpr,
      sanRoll: roll, sanLevel: level,
      status: 'rolled',
      ...sanResult
    };
    pending.result = r;

    ctx.state.scenario.events.push(
      `${pending.who} 理智检定：损失 ${sanResult.loss} 点（${sanResult.before}→${sanResult.after}）`
    );

    // 疯狂状态检查
    const ins = checkInsanity(ch);
    if (ins.note) {
      ctx.pushMessage({ role: 'system', text: `【状态】${pending.who}：${ins.note}` });
    }

    // INT 检定成功意味着调查员理解了看到的恐怖，因而陷入临时疯狂。
    if (sanResult.needsIntCheck && !ins.insane) {
      const intRoll = rollD100({});
      const intLevel = successLevel(intRoll.value, ch.attrs.INT);
      const bout = intLevel.ok;

      r.intRoll = intRoll;
      r.intLevel = intLevel;
      r.boutTriggered = bout;
      r.bout = bout;
      r.tempMadness = bout;

      if (bout) {
        if (!ch.status.includes('临时疯狂')) ch.status.push('临时疯狂');
        ctx.pushMessage({
          role: 'system',
          text: `【疯狂发作】${pending.who} 的 INT 检定成功（${intRoll.value}/${ch.attrs.INT}），因理解眼前的恐怖而陷入临时疯狂。`
        });
      } else {
        ctx.pushMessage({
          role: 'system',
          text: `【强撑】${pending.who} 的 INT 检定失败（${intRoll.value}/${ch.attrs.INT}），暂时维持住了自我。`
        });
      }
    }
    if (pending.messageId) {
      ctx.updateMessage(pending.messageId, { text: formatSanResult(r), data: r, pending: false });
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
  if (d.actorId && ctx.findCharById) return { who: d.opts['角色'], ch: ctx.findCharById(d.actorId) };
  const explicit = d.opts['角色'];
  if (explicit) {
    return { who: explicit, ch: ctx.findChar(explicit) };
  }

  const active = (ctx.state.teammates || []).find((ch) => ch.id === ctx.state.turnActorId);
  if (active) return { who: active.name, ch: active };

  const player = ctx.state.playerChar;
  if (player && (ctx.state.turnActorId || !incapacity(player))) return { who: player.name, ch: player };

  const teammates = ctx.state.teammates || [];
  const firstMate = teammates.find((character) => !incapacity(character)) || player || teammates[0];
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
  const dying = d.opts['用途'] === '濒死' && /^(?:体质|CON)$/i.test(skillName);
  const effect = dying ? 'dying' : undefined;
  const blocked = rollBlocker(ch, { effect });
  if (blocked) return { kind: 'error', text: `【检定跳过】${who}：${blocked}` };

  const base = resolveSkillValue(ch, skillName);
  const bonus = Number(d.opts['奖励'] || 0);
  const penalty = Number(d.opts['惩罚'] || 0);
  const reason = d.opts['原因'] || '';

  // 缺技能提示：无论手动还是自动都要告诉玩家
  if (base === undefined) {
    ctx.pushMessage({
      role: 'system',
      text: `【提示】${who} 没有「${skillName}」这个技能，按基础值 5 处理`
    });
  }

  return requestCheck(ctx, ch, {
    skill: skillName, baseSkill: base ?? 5, difficulty: dying ? '常规' : difficulty,
    bonus: dying ? 0 : bonus, penalty: dying ? 0 : penalty, reason, effect
  });
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
  const blocked = rollBlocker(ch, {});
  if (blocked) return { kind: 'error', text: `【理智检定跳过】${who}：${blocked}` };

  const lossExpr = d.head;
  const reason = d.opts['原因'] || '';

  // 玩家角色 → 等待玩家亲自掷骰
  if (isPlayerChar(ctx, ch)) {
    const pending = {
      id: 'roll-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      kind: 'san',
      who, charId: ch.id, lossExpr, reason,
      status: 'pending', ownerId: ctx.rollOwner?.(ch)
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
  const pending = { kind: 'san', who, charId: ch.id, lossExpr, reason, status: 'pending' };
  const r = rollPending(ctx, pending);

  // 自动掷骰时没有对应的占位消息，这里补发结果消息
  if (r) {
    ctx.pushMessage({ role: 'roll', text: formatSanResult(r), data: r });
  }
  return r;
});

// ---------------------------------------------------------------------------
// DAMAGE 和负 HP 使用同一套伤害结算。
// ---------------------------------------------------------------------------
function settleDamage(ctx, ch, rolled) {
  const who = ch.name;
  const dmg = Math.max(0, rolled.total);
  const before = ch.hp.current;
  const { majorWound, outcome } = applyDamage(ch, dmg);
  const r = {
    kind: 'damage', who, charId: ch.id, expr: rolled.expr, rolled, dmg, outcome,
    hpAfter: ch.hp.current, hpMax: ch.hp.max, delta: ch.hp.current - before, majorWound
  };
  ctx.pushMessage({
    role: 'roll',
    text: `【伤害】${who} 受到 ${dmg} 点伤害（${rolled.expr} = ${rolled.total}）→ HP ${ch.hp.current}/${ch.hp.max}`,
    data: r
  });
  if (outcome) ctx.pushMessage({ role: 'system', text: `【${outcome}】${who} 已无法行动。` });
  const con = ch.attrs?.CON;
  if (majorWound && !incapacity(ch) && Number.isFinite(con)) {
    const followUp = requestCheck(ctx, ch, { skill: '体质', baseSkill: con, reason: '重伤后保持清醒', effect: 'major-wound' });
    return { ...r, followUp };
  }
  return r;
}

define('DAMAGE', (ctx, d) => {
  const { who, ch } = pickActor(ctx, d);
  if (!ch) return { kind: 'error', text: `【伤害未结算】找不到角色「${who}」` };
  if (ch.status?.includes('死亡')) return { kind: 'error', text: `【伤害未结算】${who} 已死亡` };
  const attacker = d.opts['攻击者'] ? ctx.findChar(d.opts['攻击者']) : null;
  const rolled = rollDice(expandDb(d.head, attacker?.derived?.db));
  if (rolled.invalid) return { kind: 'error', text: `【伤害未结算】无效骰式「${d.head}」` };
  return settleDamage(ctx, ch, rolled);
});

// ---------------------------------------------------------------------------
// HP / MP —— 直接增减
// ---------------------------------------------------------------------------
for (const type of ['HP', 'MP']) {
  const field = type.toLowerCase();
  define(type, (ctx, d) => {
    const { who, ch } = pickActor(ctx, d);
    if (!ch) return { kind: 'error', text: `【${type}未结算】找不到角色「${who}」` };
    if (ch.status?.includes('死亡')) return { kind: 'error', text: `【${type}未结算】${who} 已死亡` };
    if (!/^[+-]?\d+$/.test(d.head) || !Number.isSafeInteger(Number(d.head))) {
      return { kind: 'error', text: `【${type}未结算】数值必须是整数` };
    }
    const requested = Number(d.head);
    const bar = ch[field];
    const before = bar.current;
    if (field === 'hp') {
      if (requested < 0) return settleDamage(ctx, ch, rollDice(String(-requested)));
      recoverHp(ch, requested);
    } else {
      bar.current = Math.max(0, Math.min(bar.max, before + requested));
    }
    const delta = bar.current - before;
    const text = `【${type}】${who} ${delta >= 0 ? '+' : ''}${delta} → ${bar.current}/${bar.max}`;
    ctx.pushMessage({ role: 'system', text });
    return { kind: field, who, delta, value: bar.current, max: bar.max, text };
  });
}

// ---------------------------------------------------------------------------
// ITEM —— 获得 / 失去物品
// ---------------------------------------------------------------------------
define('ITEM', (ctx, d) => {
  const { who, ch } = pickActor(ctx, d);
  if (!ch) return { kind: 'error', text: `【物品未结算】找不到角色「${who}」` };

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

  if (ctx.state.scenario.clues.includes(clue)) return { kind: 'clue', clue };
  ctx.state.scenario.clues.push(clue);
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
  if (ctx.state.scenario.ended) return null;
  ctx.state.scenario.ended = true;
  const ending = ctx.state.scenario.ending = d.head || '本次调查结束。';
  ctx.pushMessage({ role: 'scene', text: `【模组结束】${ending}` });
  return { kind: 'end', ending };
});

// ---------------------------------------------------------------------------
// 结果回喂：把本轮结算结果汇总成一段文字交回给 KP
// ---------------------------------------------------------------------------
export function summarizeResults(results) {
  const lines = results
    .filter(Boolean)
    .map((r) => {
      if (r.status === 'cancelled') return r.text;
      if (r.kind === 'check') return formatCheckResult(r);
      if (r.kind === 'san') return formatSanResult(r);
      if (r.kind === 'damage') return `【伤害】${r.who} 受到 ${r.dmg} 点伤害 → HP ${r.hpAfter}/${r.hpMax}${r.outcome ? '，' + r.outcome : r.majorWound ? '，重伤' : ''}`;
      if (r.kind === 'clue' && r.clue) return `【线索】${r.clue}`;
      if (r.kind === 'scene') return `【场景】${r.scene}`;
      if (r.kind === 'end') return `【模组结束】${r.ending}`;
      return r.text || '';
    })
    .filter(Boolean);

  return lines.join('\n');
}
