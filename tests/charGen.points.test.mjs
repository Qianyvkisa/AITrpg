// ---------------------------------------------------------------------------
// AI 车卡技能点回归测试
//
// 真实 bug：AI 自己生成的卡技能点没点满。
//   实测三张典型卡平均浪费 47% 的预算，兴趣点只用了 13~25%。
//   技能点没花完的卡在跑团里明显偏弱，玩家还得手动补齐。
//
// 附带发现的两个相关 bug：
//   BUG2 AI 给「闪避」「母语」加的点会被强制抹回初始值（等于每次生成都白吞）
//   BUG3 AI 有时把职业点堆到严重超支（预算 200 却花了 450），此前没有任何校验
//
// 测试全部走 charFromAI / fillSkillPoints 的真实代码路径，
// 账目用 skillPointBudget 计算——和角色卡编辑器里显示的完全一致。
// ---------------------------------------------------------------------------

import { charFromAI, fillSkillPoints } from '../src/services/charGen.js';
import { skillPointBudget, isOccupationalSkill } from '../src/core/occupations.js';
import { SKILL_DEFS, baseSkillValue, createCharacter, normalizeCharacter, refreshDerived } from '../src/core/character.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/** 和编辑器一致地算账 */
function budgetOf(ch) {
  const baseOf = (name) => {
    const def = SKILL_DEFS.find((d) => d.name === name);
    return def ? baseSkillValue(def, ch.attrs) : 0;
  };
  const isOcc = (name) => isOccupationalSkill(ch, name, (x) => (ch.customNames || {})[x] || '');
  return skillPointBudget(ch, baseOf, isOcc);
}

/** 生成一张卡（不补点），用于对比 */
const gen = (raw) => charFromAI(raw, { isPlayer: false });

console.log('== AI 车卡技能点 ==');

// ---- 用例 1：AI 撒点偏少的卡，补完必须没有余额 ----
{
  const raw = {
    name: '陈默', occupation: '记者', age: 32,
    attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 55, INT: 70, POW: 60, EDU: 75, LUCK: 50 },
    skills: {
      '侦查': 55, '聆听': 50, '图书馆使用': 60, '心理学': 45, '话术': 40,
      '母语': 75, '历史': 40, '说服': 35
    }
  };

  const before = budgetOf(gen(raw));
  ok(before.occLeft > 0, '前提：补点前确实有职业点没花完');
  ok(before.intLeft > 0, '前提：补点前确实有兴趣点没花完');

  const ch = gen(raw);
  fillSkillPoints(ch);
  const after = budgetOf(ch);

  eq(after.occLeft, 0, '补完后职业点全部花完');
  eq(after.intLeft, 0, '补完后兴趣点全部花完');
  eq(after.occUsed, after.occTotal, '职业点用量等于总额');
  eq(after.intUsed, after.intTotal, '兴趣点用量等于总额');
}

// ---- 用例 2：医生这种本职技能少、预算大的职业也要点满 ----
{
  const raw = {
    name: '林素', occupation: '医生', age: 38,
    attrs: { STR: 45, CON: 50, SIZ: 55, DEX: 60, APP: 60, INT: 75, POW: 65, EDU: 80, LUCK: 45 },
    skills: { '医学': 70, '急救': 65, '心理学': 55, '图书馆使用': 50, '侦查': 45 }
  };

  const ch = gen(raw);
  fillSkillPoints(ch);
  const b = budgetOf(ch);

  eq(b.occLeft, 0, '医生卡职业点也要花完');
  eq(b.intLeft, 0, '医生卡兴趣点也要花完');
  ok(b.occTotal >= 300, '前提：医生预算确实很大（EDU80×4）');
}

// ---- 用例 3：BUG2 —— 闪避/母语的加点不能被抹掉 ----
{
  const raw = {
    name: '赵铁', occupation: '退伍军官',
    attrs: { STR: 70, CON: 65, SIZ: 70, DEX: 60, APP: 50, INT: 60, POW: 60, EDU: 65, LUCK: 55 },
    // DEX60 → 闪避初始 30，AI 给 40 等于加了 10 点
    // EDU65 → 母语初始 65，AI 给 80 等于加了 15 点
    skills: { '闪避': 40, '母语': 80, '格斗：斗殴': 65 }
  };

  const ch = gen(raw);
  ok(ch.skills['闪避'] >= 40, '闪避的加点被保留（不低于 AI 给的 40）');
  ok(ch.skills['母语'] >= 80, '母语的加点被保留（不低于 AI 给的 80）');

  // 也不能低于属性算出的初始值
  ok(ch.skills['闪避'] >= Math.floor(ch.attrs.DEX / 2), '闪避不低于 DEX/2');
  ok(ch.skills['母语'] >= ch.attrs.EDU, '母语不低于 EDU');
}

// ---- 用例 4：AI 给闪避低于初始值时，抬回初始值 ----
{
  const raw = {
    name: '慢吞吞', occupation: '记者',
    attrs: { DEX: 70, EDU: 80 },
    skills: { '闪避': 20, '母语': 50 } // 都低于初始值（35 / 80）
  };
  const ch = gen(raw);
  eq(ch.skills['闪避'], Math.floor(70 / 2), '闪避低于初始值时抬回 DEX/2');
  eq(ch.skills['母语'], 80, '母语低于初始值时抬回 EDU');
}

// ---- 用例 5：BUG3 —— 职业点严重超支要被削回来 ----
{
  const raw = {
    name: '贪心', occupation: '记者',
    attrs: { EDU: 50, INT: 30 }, // 职业点 200，兴趣点 60
    skills: {
      '侦查': 90, '聆听': 90, '图书馆使用': 90,
      '心理学': 90, '话术': 90, '说服': 90
    }
  };

  const before = budgetOf(gen(raw));
  ok(before.occLeft < 0, '前提：AI 把职业点堆超支了');

  const ch = gen(raw);
  fillSkillPoints(ch);
  const after = budgetOf(ch);

  ok(after.occLeft >= 0, '超支的职业点被削回预算内');
  eq(after.occUsed, after.occTotal, '削完后职业点刚好用满');
  eq(after.intLeft, 0, '削完后兴趣点也用满');
  ok(after.occLeft >= 0 && after.intLeft >= 0, '补完后不存在任何超支');
}

// ---- 用例 6：克苏鲁神话恒为 0，补点也不许碰 ----
{
  const raw = {
    name: '疯子', occupation: '神秘学家',
    attrs: { EDU: 60, INT: 60 },
    skills: { '克苏鲁神话': 40 } // AI 违规给了 40
  };
  const ch = gen(raw);
  eq(ch.skills['克苏鲁神话'], 0, 'AI 给的克苏鲁神话被归零');

  fillSkillPoints(ch);
  eq(ch.skills['克苏鲁神话'], 0, '补点不会给克苏鲁神话加点');
}

// ---- 用例 7：职业不在职业表里时不凭空造职业点 ----
{
  const raw = {
    name: '怪人', occupation: '赛博格', // 表里没有这个职业
    attrs: { EDU: 60, INT: 70 },
    skills: {}
  };
  const ch = gen(raw);
  fillSkillPoints(ch);
  const b = budgetOf(ch);

  eq(b.occTotal, 0, '未知职业的职业点为 0（不凭空编造）');
  eq(b.occUsed, 0, '未知职业不该被加上职业点');
  eq(b.intLeft, 0, '未知职业仍要把兴趣点花完');
}

// ---- 用例 8：单技能不超过 99 ----
{
  const raw = {
    name: '天才', occupation: '医生',
    attrs: { STR: 40, CON: 40, SIZ: 40, DEX: 40, APP: 40, INT: 90, POW: 40, EDU: 99, LUCK: 40 },
    skills: { '医学': 99 }
  };
  const ch = gen(raw);
  fillSkillPoints(ch);

  for (const [name, val] of Object.entries(ch.skills)) {
    ok(val <= 99, `技能「${name}」不超过 99（实际 ${val}）`);
  }
  ok(ch.skills['医学'] <= 99, '已经 99 的技能不会被推过上限');
}

// ---- 用例 9：幂等 —— 补两次结果一致 ----
{
  const raw = {
    name: '重复', occupation: '记者',
    attrs: { EDU: 70, INT: 60 },
    skills: { '侦查': 50 }
  };
  const ch = gen(raw);
  fillSkillPoints(ch);
  const once = budgetOf(ch);
  const skillsOnce = JSON.stringify(ch.skills);

  fillSkillPoints(ch);
  const twice = budgetOf(ch);

  eq(twice.occLeft, once.occLeft, '补两次职业点余额不变');
  eq(twice.intLeft, once.intLeft, '补两次兴趣点余额不变');
  eq(JSON.stringify(ch.skills), skillsOnce, '补两次技能值完全不变');
}

// ---- 用例 10：空技能表也能点满（AI 什么都没给的情况）----
{
  const raw = {
    name: '新人', occupation: '记者',
    attrs: { EDU: 70, INT: 60 },
    skills: {}
  };
  const ch = gen(raw);
  fillSkillPoints(ch);
  const b = budgetOf(ch);

  eq(b.occLeft, 0, '空技能表也能把职业点花完');
  eq(b.intLeft, 0, '空技能表也能把兴趣点花完');
  ok(Object.values(ch.skills).some((v) => v > 0), '确实加上了技能');
}

// ---- 用例 11：本职技能优先，别把点撒到无关技能 ----
{
  const raw = {
    name: '医生甲', occupation: '医生',
    attrs: { EDU: 80, INT: 40 },
    skills: {}
  };
  const ch = gen(raw);
  fillSkillPoints(ch);

  // 医生的固定本职：医学/图书馆使用/心理学/急救
  const occAvg = ['医学', '图书馆使用', '心理学', '急救']
    .map((s) => ch.skills[s] || 0)
    .reduce((a, b) => a + b, 0) / 4;
  ok(occAvg > 40, `本职技能被优先抬高（本职平均 ${occAvg}，应明显高于初始值）`);
}

// ---- 用例 12：老存档没有 skillsBase，不能被凭空多算出加点 ----
//
// 曾经的坑：normalizeCharacter 用 createCharacter 的默认 skillsBase 去兜底，
// 于是 refreshDerived 把「当前值 − 默认初始值」当成加点，母语 85 会被算成
// 105（还突破了 99）。老存档没有快照就应当视为「加点未知」。
{
  const legacy = {
    name: '老卡', occupation: '记者',
    attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 60, APP: 50, INT: 50, POW: 50, EDU: 70, LUCK: 50 },
    skills: { '闪避': 80, '母语': 85, '侦查': 60 }  // 没有 skillsBase 字段
  };
  const ch = normalizeCharacter(legacy);
  ok(ch.skills['闪避'] <= 99, `老存档闪避不超过 99（实际 ${ch.skills['闪避']}）`);
  ok(ch.skills['母语'] <= 99, `老存档母语不超过 99（实际 ${ch.skills['母语']}）`);
  eq(ch.skills['闪避'], 80, '老存档闪避保留原值');
  eq(ch.skills['母语'], 85, '老存档母语保留原值');
}

// ---- 用例 13：反复 refreshDerived 不会让技能值膨胀 ----
{
  const ch = createCharacter({ name: '新卡' });
  ch.attrs.DEX = 60;
  ch.attrs.EDU = 70;
  refreshDerived(ch);
  eq(ch.skills['闪避'], 30, '新卡闪避按 DEX/2');

  ch.skills['闪避'] = 80;
  for (let i = 0; i < 10; i++) refreshDerived(ch);
  eq(ch.skills['闪避'], 80, '连续 refresh 10 次，闪避加点不膨胀');
  ok(ch.skills['闪避'] <= 99, '闪避始终不超过 99');
}

// ---- 用例 14：技能值任何情况下都不超过 99 ----
{
  const ch = createCharacter({ name: '上限' });
  ch.attrs.DEX = 99;
  ch.attrs.EDU = 99;
  refreshDerived(ch);
  ch.skills['闪避'] = 200;  // 故意塞个非法值
  ch.skills['母语'] = 200;
  refreshDerived(ch);

  ok(ch.skills['闪避'] <= 99, `闪避被夹到 99 以内（实际 ${ch.skills['闪避']}）`);
  ok(ch.skills['母语'] <= 99, `母语被夹到 99 以内（实际 ${ch.skills['母语']}）`);
}

// ---- 收尾 ----
console.log('\n' + '='.repeat(42));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('全部通过');
}
