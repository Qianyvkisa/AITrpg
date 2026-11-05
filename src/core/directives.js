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
// CHECK —— 技能检定
// ---------------------------------------------------------------------------
define('CHECK', (ctx, d) => {
  const who = d.opts['角色'] || ctx.state.playerChar?.name || '调查员';
  const difficulty = d.opts['难度'] || '常规';
  const skillName = d.head;

  const ch = ctx.findChar(who);
  if (!ch) {
    return { text: `【系统】找不到角色「${who}」`, kind: 'error' };
  }

  const base = resolveSkillValue(ch, skillName);
  const skillValue = base ?? 5;
  const adjusted = difficultyToSkill(skillValue, difficulty);

  const bonus = Number(d.opts['奖励'] || 0);
  const penalty = Number(d.opts['惩罚'] || 0);
  const roll = rollD100({ bonus, penalty });
  const level = successLevel(roll.value, adjusted);

  const r = {
    kind: 'check',
    who, skill: skillName, difficulty,
    baseSkill: skillValue, adjusted, roll, level,
    reason: d.opts['原因'] || ''
  };

  ctx.pushMessage({ role: 'roll', text: formatCheckResult(r), data: r });
  ctx.state.scenario.events.push(`${who} ${skillName}检定 → ${level.label}（${roll.value}/${adjusted}）`);

  if (base === undefined) {
    ctx.pushMessage({
      role: 'system',
      text: `【提示】${who} 没有「${skillName}」这个技能，按基础值 5 处理`
    });
  }

  return r;
});

// ---------------------------------------------------------------------------
// SAN —— 理智检定
// ---------------------------------------------------------------------------
define('SAN', (ctx, d) => {
  const who = d.opts['角色'] || ctx.state.playerChar?.name;
  const ch = targetChar(ctx, d);
  if (!ch) return null;

  const lossExpr = d.head;
  const reason = d.opts['原因'] || '';

  // SAN 检定本身是一次 POW 检定
  const roll = rollD100({});
  const level = successLevel(roll.value, ch.attrs.POW);
  const sanResult = applySanCheck(ch, lossExpr, roll, level);

  const r = {
    kind: 'san',
    who, reason, lossExpr,
    powRoll: roll, powLevel: level,
    ...sanResult
  };

  ctx.pushMessage({ role: 'roll', text: formatSanResult(r), data: r });
  ctx.state.scenario.events.push(
    `${who} 理智检定：损失 ${sanResult.loss} 点（${sanResult.before}→${sanResult.after}）`
  );

  // 疯狂状态检查
  const ins = checkInsanity(ch);
  if (ins.note) {
    ctx.pushMessage({ role: 'system', text: `【状态】${who}：${ins.note}` });
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
        text: `【疯狂发作】${who} 的理智遭到冲击，INT 检定失败（${intRoll.value}/${ch.attrs.INT}），陷入疯狂发作。`
      });
    } else {
      ctx.pushMessage({
        role: 'system',
        text: `【强撑】${who} 勉强维持住了自我（INT 检定成功 ${intRoll.value}/${ch.attrs.INT}），但精神已受重创。`
      });
    }
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
