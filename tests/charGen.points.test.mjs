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

import { charFromAI, fillSkillPoints, randomCharacter } from '../src/services/charGen.js';
import {
  skillPointBudget, isOccupationalSkill, findOccupation, SOCIAL_SKILLS, OCCUPATIONS
} from '../src/core/occupations.js';
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
//
// 注意这里**不能**用 charFromAI 造卡：AI 车卡路径现在会把表外职业名
// 纠正成表内职业（见用例 15），occTotal 自然不为 0。
// 本用例保护的是 fillSkillPoints 自身的约束——无论职业查不查得到，
// 它都不许凭空编出职业点来。所以直接构造一张职业名诡异的卡。
{
  const ch = createCharacter({ name: '怪人', isPlayer: false });
  ch.occupation = '赛博格'; // 表里没有这个职业，且不走 AI 纠正
  ch.attrs.EDU = 60;
  ch.attrs.INT = 70;
  refreshDerived(ch);

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

// ---- 用例 15：AI 自创的表外职业名也要能算出职业点 ----
//
// 真实 bug：AI 常写「退伍军人」「赛博格」「电竞选手」这类名字。
// findOccupation 查不到 → 职业点算成 0 → AI 加的战斗技能全变成兴趣点 →
// 账目超支，技能页还提示「这个职业不在职业表里」。玩家看到的就是一张废卡。
//
// 修法分两层：常见的自创写法进别名表（职业名保留原样，人设味道不丢）；
// 别名也没收录的，按「AI 把点加在哪」反推一个表内职业。
{
  const raw = {
    name: '沈砚', occupation: '退伍军人',
    attrs: { STR: 65, CON: 60, SIZ: 65, DEX: 55, APP: 50, INT: 60, POW: 65, EDU: 60, LUCK: 45 },
    skills: { '格斗：斗殴': 60, '射击：手枪': 55, '闪避': 40, '母语': 70, '侦查': 45, '急救': 50 }
  };
  const ch = gen(raw);

  ok(!!findOccupation(ch.occupation),
    `自创职业名能被识别（实际「${ch.occupation}」）`);

  // 关键：必须挑一个「战斗技能算本职」的职业，否则 AI 加的点全废
  const b0 = budgetOf(ch);
  ok(b0.occTotal > 0, '自创职业名也能算出职业点（不再是 0）');

  fillSkillPoints(ch);
  const b = budgetOf(ch);
  ok(b.occLeft >= 0, '职业点不超支');
  eq(b.occLeft, 0, '职业点能花完');
  eq(b.intLeft, 0, '兴趣点也能花完');
}

// ---- 用例 15b：别名表完全没收录的怪名字，也要落到一个表内职业 ----
{
  const raw = {
    name: '怪人', occupation: '赛博格',
    attrs: { STR: 60, CON: 55, SIZ: 55, DEX: 65, APP: 50, INT: 60, POW: 55, EDU: 60, LUCK: 50 },
    skills: { '格斗：斗殴': 70, '射击：手枪': 65 }
  };
  const ch = gen(raw);

  ok(!!findOccupation(ch.occupation),
    `怪名字被纠正成表内职业（实际「${ch.occupation}」）`);
  ok(budgetOf(ch).occTotal > 0, '纠正后职业点不为 0');
}

// ---- 用例 16：能查到的职业名不许被改动 ----
{
  const raw = {
    name: '白露', gender: '女', occupation: '记者',
    attrs: { EDU: 70, INT: 60 }, skills: { '侦查': 50 }
  };
  const ch = gen(raw);
  eq(ch.occupation, '记者', '标准职业名原样保留');
  eq(ch.gender, '女', 'AI 给了性别就原样保留');
}

// ---- 用例 17：AI 漏掉性别时不能留空 ----
{
  const raw = {
    name: '无名', occupation: '记者',
    attrs: { EDU: 70, INT: 60 }, skills: {}
  };
  const ch = gen(raw);
  ok(String(ch.gender || '').trim() !== '', '性别字段被兜底填上，不是空格子');
}

// ---- 用例 18：别名职业（护士长）要映射到标准职业，但职业点算得出来 ----
{
  const raw = {
    name: '护工', occupation: '护士长',
    attrs: { EDU: 60, INT: 60 }, skills: { '急救': 70 }
  };
  const ch = gen(raw);
  ok(!!findOccupation(ch.occupation), `别名职业能查到（实际「${ch.occupation}」）`);
  fillSkillPoints(ch);
  const b = budgetOf(ch);
  eq(b.occLeft, 0, '别名职业的卡职业点也能花完');
  eq(b.intLeft, 0, '别名职业的卡兴趣点也能花完');
}

// ---- 用例 19：兴趣点要集中在少数技能上，不许撒胡椒面 ----
//
// 早期实现把兴趣点平均摊到 30 多项技能，每项加 3~4 点。
// 这种卡实战里没有一项能过检定，玩家一看就知道分配坏了。
{
  const raw = {
    name: '白露', occupation: '记者',
    attrs: { STR: 45, CON: 50, SIZ: 45, DEX: 65, APP: 65, INT: 75, POW: 55, EDU: 70, LUCK: 60 },
    skills: { '侦查': 60, '聆听': 55, '图书馆使用': 65, '话术': 40, '母语': 70, '心理学': 45 },
    customNames: { '技艺①': '摄影' }
  };
  const ch = gen(raw);
  fillSkillPoints(ch);

  // 统计「兴趣点加到了多少项技能上」
  const baseOf = (n) => {
    const d = SKILL_DEFS.find((x) => x.name === n);
    return d ? baseSkillValue(d, ch.attrs) : 0;
  };
  const isOcc = (n) => isOccupationalSkill(ch, n, (x) => (ch.customNames || {})[x] || '');
  const intTouched = Object.entries(ch.skills)
    .filter(([n, v]) => v - baseOf(n) > 0 && !isOcc(n));

  ok(intTouched.length <= 12,
    `兴趣点集中在少数技能上（实际 ${intTouched.length} 项，应 ≤ 12）`);

  // 而且不能全砸在战斗技能上
  const combat = ['格斗：斗殴', '射击：手枪'];
  const combatPts = combat.reduce((s, n) => s + Math.max(0, (ch.skills[n] || 0) - baseOf(n)), 0);
  ok(combatPts <= 20, `记者的兴趣点没被砸到战斗技能上（战斗共 ${combatPts} 点，应 ≤ 20）`);
}

// ---- 用例 20：带「任意特长」的职业也要把职业点花完 ----
//
// 152/225 个职业写着「任意特长可选 N 项」（occupations.js 的 free）。
// 这些职业光靠 fixed 那几项本职技能，点数根本花不完——实测贵族剩 152 点、
// 医生剩 25 点，账目永远平不了。修法是替 AI 选出那 N 项特长
// （记在 ch.occFreeSkills 里），选中即算本职。
{
  const cases = [
    ['贵族', { EDU: 85, INT: 70 }, { '法律': 70, '骑术': 65 }],
    ['医生', { EDU: 90, INT: 80 }, { '医学': 80, '急救': 75, '心理学': 70 }],
    ['医生（原作向）', { EDU: 80, INT: 75 }, { '医学': 75, '急救': 70 }]
  ];
  for (const [occ, attrs, skills] of cases) {
    const ch = gen({ name: '特长测试', occupation: occ, attrs, skills });
    fillSkillPoints(ch);
    const b = budgetOf(ch);
    eq(b.occLeft, 0, `${occ} 的职业点能花完（剩 ${b.occLeft}）`);
    eq(b.intLeft, 0, `${occ} 的兴趣点能花完（剩 ${b.intLeft}）`);
    ok((ch.occFreeSkills || []).length > 0, `${occ} 选出了任意特长`);
  }
}

// ---- 用例 21：社交技能要按职业允许的项数分配，不能 4 项全填 ----
//
// 职业写「选 2 项社交技能」时，isOccupationalSkill 会把 4 项都判成本职
// （程序不知道玩家选哪两项）。但分配时要是 4 项都填，每张卡都会长着
// 「话术/取悦/恐吓/说服 全 60+」的脸，完全不像真人车的卡。
{
  const ch = gen({
    name: '社交测试', occupation: '记者',
    attrs: { EDU: 70, INT: 70, APP: 65 },
    skills: {}
  });
  fillSkillPoints(ch);

  const baseOf = (n) => {
    const d = SKILL_DEFS.find((x) => x.name === n);
    return d ? baseSkillValue(d, ch.attrs) : 0;
  };
  const raised = SOCIAL_SKILLS.filter((s) => (ch.skills[s] || 0) - baseOf(s) > 0);
  const quota = findOccupation(ch.occupation).social || 0;

  ok(raised.length <= quota,
    `社交技能只填了 ${raised.length} 项（职业允许 ${quota} 项）`);
}

// ---- 用例 22：randomCharacter 造出来的卡账目必须是平的 ----
//
// 早期实现按 EDU*4 硬编码撒点、完全不看职业，结果一张没填职业的卡
// 兴趣点能用掉 220 点（预算只有 INT×2=90），账目红成一片。
// 而且它连职业和性别都留空。
{
  for (let i = 0; i < 30; i++) {
    const ch = randomCharacter({ name: `随机${i}`, isPlayer: true });
    const b = budgetOf(ch);

    ok(String(ch.occupation || '').trim() !== '', `随机卡 #${i} 有职业`);
    ok(!!findOccupation(ch.occupation), `随机卡 #${i} 的职业在表里（${ch.occupation}）`);
    ok(String(ch.gender || '').trim() !== '', `随机卡 #${i} 有性别`);

    eq(b.occLeft, 0, `随机卡 #${i} 职业点刚好花完（剩 ${b.occLeft}）`);
    eq(b.intLeft, 0, `随机卡 #${i} 兴趣点刚好花完（剩 ${b.intLeft}）`);

    // 产品约定：随机卡的闪避恒等于 DEX/2
    eq(ch.skills['闪避'], Math.floor(ch.attrs.DEX / 2),
      `随机卡 #${i} 的闪避 = DEX/2`);
  }
}

// ---------------------------------------------------------------------------
// v0.2.0 回归：特长标记与技能点账目不能串账
//
// 真实 bug：老逻辑是「先分点、后选任意特长」。
// 分点时那些技能按「兴趣点」记账，等后来被标成本职，账目整体挪到职业点
// 名下 —— 于是职业点凭空超支、兴趣点凭空剩出，两边数额恰好互为相反数。
// 实测 225 个职业里 9 个中招，最惨的「业余艺术爱好者」是 occ -135 / int +135，
// 玩家看到的就是「职业点红了、兴趣点还剩一大堆」，怎么调都调不平。
// ---------------------------------------------------------------------------
console.log('\n== v0.2.0 回归：特长与账目不能串账 ==');

{
  // 贵族：EDU*2+MAX(EDU*2,APP*2) 预算 340，free=3，fixed 只有法律/骑术。
  // 这是原先串账最典型的职业之一。
  const ch = charFromAI({
    name: '贵族甲', occupation: '贵族',
    attrs: { STR: 45, CON: 45, SIZ: 50, DEX: 55, APP: 70, INT: 75, POW: 60, EDU: 85, LUCK: 55 },
    skills: { '话术': 50, '说服': 45 }
  }, {});
  fillSkillPoints(ch);
  const b = budgetOf(ch);

  eq(b.occLeft, 0, '贵族：职业点不超支也不剩余');
  eq(b.intLeft, 0, '贵族：兴趣点不超支也不剩余');

  // 特长名额不能被突破
  const occ = findOccupation(ch.occupation);
  ok((ch.occFreeSkills || []).length <= (Number(occ?.free) || 0),
    `贵族：特长数量不超过名额（${(ch.occFreeSkills || []).length}/${occ?.free}）`);
}

{
  // 全职业扫一遍：既不能超支，也不能出现串账。
  //
  // 职业点剩一点点是规则允许的（比如 free 名额用满、固定本职全到 99），
  // 但绝不能出现「职业点负、兴趣点正」这种串账。
  const ATTRS_FIX = { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 55, INT: 70, POW: 60, EDU: 75, LUCK: 50 };
  let overCount = 0;
  let crossCount = 0;
  const bad = [];

  for (const occ of OCCUPATIONS) {
    const ch = charFromAI({
      name: '测试', occupation: occ.name, attrs: { ...ATTRS_FIX },
      skills: { '侦查': 55, '聆听': 50, '图书馆使用': 60, '心理学': 45 }
    }, {});
    fillSkillPoints(ch);
    const b = budgetOf(ch);

    if (b.occLeft < 0 || b.intLeft < 0) {
      overCount++;
      bad.push(`${ch.occupation}: 超支 occ ${b.occLeft} int ${b.intLeft}`);
    }
    // 串账：一边负数、另一边正数
    if ((b.occLeft < 0 && b.intLeft > 0) || (b.intLeft < 0 && b.occLeft > 0)) {
      crossCount++;
      bad.push(`${ch.occupation}: 串账 occ ${b.occLeft} int ${b.intLeft}`);
    }
  }

  eq(overCount, 0, '全职业：没有任何职业出现点数超支');
  eq(crossCount, 0, '全职业：没有任何职业出现职业点/兴趣点串账');
  if (bad.length) console.log('    问题：' + bad.slice(0, 5).join(' | '));
}

{
  // AI 给出低于初始值的技能，不能把初始值顶掉。
  //
  // 真实 bug：AI 写「急救: -20」，老逻辑夹到 0，于是急救从初始值 30 变成 0，
  // 凭空扣掉 30 点预算；skillPointBudget 只累加 spent > 0 的部分，
  // 那 30 点既不算已用也分不出去，账目永远差 30。
  const ch = charFromAI({
    name: '阿丁', occupation: '医生',
    attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 55, INT: 70, POW: 60, EDU: 75, LUCK: 50 },
    skills: { '急救': -20, '医学': 999, '闪避': 1, '母语': 0 }
  }, {});

  ok(ch.skills['急救'] >= 30, `急救不能低于初始值 30（实际 ${ch.skills['急救']}）`);
  eq(ch.skills['医学'], 99, '医学超过 99 被夹到 99');
  ok(ch.skills['闪避'] >= Math.floor(ch.attrs.DEX / 2),
    `闪避不能低于 DEX/2（实际 ${ch.skills['闪避']}）`);
  ok(ch.skills['母语'] >= ch.attrs.EDU,
    `母语不能低于 EDU（实际 ${ch.skills['母语']}）`);

  fillSkillPoints(ch);
  const b = budgetOf(ch);
  eq(b.occLeft, 0, '医生（含非法输入）：职业点补平');
  eq(b.intLeft, 0, '医生（含非法输入）：兴趣点补平');
}

{
  // 换职业后，旧职业残留的特长标记必须被清掉，
  // 否则那些技能会一直白吃新职业的职业点，把账目算歪。
  const ch = charFromAI({
    name: '换职业', occupation: '贵族',
    attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 55, INT: 70, POW: 60, EDU: 75, LUCK: 50 },
    skills: {}
  }, {});
  fillSkillPoints(ch);
  ok((ch.occFreeSkills || []).length > 0, '前提：贵族确实选出了特长');

  // 换成没有 free 名额的职业（记者 free=undefined，只有 social 名额）
  ch.occupation = '记者';
  fillSkillPoints(ch);
  eq((ch.occFreeSkills || []).length, 0, '换到无特长名额的职业后，残留标记被清空');

  const b = budgetOf(ch);
  eq(b.occLeft, 0, '换职业后职业点仍然补平');
  eq(b.intLeft, 0, '换职业后兴趣点仍然补平');
}

// ---- v0.2.1 回归：职业点必须能花完，不能留闲置预算 ----
//
// 真实 bug：玩家反馈「AI 生成的卡还是不会把职业技能点/兴趣技能点用完」。
// 排查发现两个原因：
//   1) 「添加 AI 队友」弹窗（teammateCreator）完全没走补点逻辑，
//      填个职业点两项技能，职业点能剩 250 点、兴趣点剩 150 点；
//   2) 法医 / 医疗技术员 / 科学搜查研究员 这 3 个职业的固定本职技能太少，
//      全部顶到 99 也装不下 EDU×4 的预算（缺口 56 / 41 / 130 点），
//      属于职业表缺项。
console.log('\n== v0.2.1 回归：职业点不能留闲置预算 ==');

// ---- 用例：EDU 拉满时，每个职业都必须把点数花完 ----
{
  const worst = [];
  for (const occ of OCCUPATIONS) {
    const ch = gen({
      name: '测试', occupation: occ.name, age: 30,
      // EDU 99 是预算上限，最容易暴露「本职技能池装不下预算」
      attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 99, POW: 50, EDU: 99 },
      skills: {}   // AI 一项技能都不给，最糟情况
    });
    fillSkillPoints(ch);
    const b = budgetOf(ch);
    if (b.occLeft > 0 || b.intLeft > 0) {
      worst.push(`${ch.occupation}(职业剩${b.occLeft}/兴趣剩${b.intLeft})`);
    }
  }
  eq(worst.length, 0, `EDU99 时全职业都不该有闲置点数${worst.length ? '：' + worst.slice(0, 5).join('、') : ''}`);
}

// ---- 用例：这 3 个曾经的「重灾区」职业必须补齐 ----
{
  for (const occName of ['法医', '医疗技术员', '科学搜查研究员']) {
    const ch = gen({
      name: '测试', occupation: occName, age: 30,
      attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 99, POW: 50, EDU: 99 },
      skills: {}
    });
    fillSkillPoints(ch);
    const b = budgetOf(ch);
    eq(b.occLeft, 0, `${occName}：职业点花完`);
    eq(b.intLeft, 0, `${occName}：兴趣点花完`);
  }
}

// ---- 用例：模拟「添加 AI 队友」的建卡路径 ----
//
// teammateCreator 原来是 createCharacter + 手填技能，直接 push 进队友列表，
// 从不调用 fillSkillPoints。这里复刻那条路径，验证补点后账目干净。
{
  for (const occName of ['退伍军医', '记者', '医生', '队医']) {
    const ch = createCharacter({ name: '队友', isPlayer: false });
    ch.attrs = { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 45, INT: 70, POW: 60, EDU: 75 };
    refreshDerived(ch);
    ch.occupation = occName;
    // 玩家只填两项擅长技能（teammateCreator 里的行为）
    ch.skills['急救'] = Math.max(ch.skills['急救'] ?? 0, 60);
    ch.skills['医学'] = Math.max(ch.skills['医学'] ?? 0, 60);

    const before = budgetOf(ch);
    ok(before.occLeft > 0 || before.intLeft > 0, `前提：${occName} 建卡时确实有大量点数没花`);

    fillSkillPoints(ch);
    const after = budgetOf(ch);
    eq(after.occLeft, 0, `${occName}：队友建卡补点后职业点花完`);
    eq(after.intLeft, 0, `${occName}：队友建卡补点后兴趣点花完`);
  }
}

// ---- 用例：补点后账目不能反过来超支 ----
{
  for (const occName of ['法医', '医疗技术员', '科学搜查研究员', '记者', '士兵']) {
    const ch = gen({
      name: '测试', occupation: occName, age: 30,
      attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 80, POW: 50, EDU: 85 },
      skills: { '侦查': 70 }
    });
    fillSkillPoints(ch);
    const b = budgetOf(ch);
    ok(b.occLeft >= 0, `${occName}：职业点不超支（剩 ${b.occLeft}）`);
    ok(b.intLeft >= 0, `${occName}：兴趣点不超支（剩 ${b.intLeft}）`);
  }
}

// ---- 用例：AI 大面积铺点时必须削得干净（v0.2.2 修）----
//
// 真实 bug：AI 有时不听「集中在少数几项」的劝，给几十项技能各加几十点。
// 兴趣点预算只有 INT×2（约 140），却能超支 4000+ 点。
//
// 旧实现（v0.2.1 及之前）的 trimOverflow 是「每轮削 1 点、最多 2000 轮」，
// 超支超过 2000 点时循环被 guard 强行截断，剩下的超支原样留在卡上：
//   实测 会计师 + 全技能90 → 兴趣点剩 -2148
// 玩家在编辑器里看到红字，怎么调都平不了。
//
// 修法：改成一次性批量削（算出该侧总超支，直接从技能上扣掉），
// 并且从「加点最少」的开始削，保住少数高值技能。
{
  const allAt = (v) => {
    const s = {};
    for (const d of SKILL_DEFS) {
      if (d.name === '克苏鲁神话') continue;   // 车卡阶段恒为 0
      s[d.name] = d.custom ? Math.min(v, 60) : v;
    }
    return s;
  };

  // 挑几个 free 少 / 本职技能少的职业，最容易撞上 guard 上限
  const occs = ['会计师', '杂技演员', '动物训练师', '酒保', '神职人员', '管家、男仆、女仆'];

  for (const fill of [90, 99]) {
    for (const occName of occs) {
      const ch = gen({
        name: '测试', occupation: occName, age: 30, gender: '男',
        attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 45, INT: 70, POW: 60, EDU: 90 },
        skills: allAt(fill),
        customNames: { '技艺①': '摄影', '外语①': '拉丁语', '科学①': '化学' }
      });

      const before = budgetOf(ch);
      ok(before.intLeft < -2000, `前提：${occName} 全技能${fill} 时兴趣点确实超支 2000 点以上（实际 ${before.intLeft}）`);

      fillSkillPoints(ch);
      const after = budgetOf(ch);
      eq(after.occLeft, 0, `${occName} 全技能${fill}：超支削干净后职业点刚好花完`);
      eq(after.intLeft, 0, `${occName} 全技能${fill}：超支削干净后兴趣点刚好花完`);
    }
  }
}

// ---- 用例：信用评级 / 克苏鲁神话这类「不参与补点」的技能，超支时也要能削 ----
//
// 真实 bug：trimOverflow 里跳过了 EXCLUDED（信用评级/克苏鲁神话/自定义技能），
// 但 skillPointBudget 算账时是照单全收的——AI 给信用评级写 99，那 99 点
// 就实打实记在非本职账上。跳过后这些技能永远削不掉，账目永远差一截
// （实测兴趣点剩 -58，怎么都平不了）。
{
  const ch = gen({
    name: '测试', occupation: '会计师', age: 30,
    attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 45, INT: 70, POW: 60, EDU: 90 },
    skills: { '信用评级': 99, '会计': 90, '法律': 90 },
    customNames: {}
  });
  fillSkillPoints(ch);
  const b = budgetOf(ch);
  eq(b.occLeft, 0, '信用评级堆到 99 时职业点仍能花完');
  eq(b.intLeft, 0, '信用评级堆到 99 时兴趣点仍能花完');
  ok(b.intUsed <= b.intTotal, '信用评级算进兴趣账，但不许超支');
}

// ---- 用例：全 225 个职业 × 大面积铺点，账目一律要平 ----
//
// 这是上面几条的兜底：只要有一个职业削不干净，就说明批量削减逻辑还有漏洞。
{
  let bad = 0;
  const badNames = [];
  for (const occ of OCCUPATIONS) {
    const ch = gen({
      name: '测试', occupation: occ.name, age: 30, gender: '男',
      attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 45, INT: 70, POW: 60, EDU: 90 },
      skills: (() => {
        const s = {};
        for (const d of SKILL_DEFS) {
          if (d.name === '克苏鲁神话') continue;
          s[d.name] = d.custom ? 60 : 90;
        }
        return s;
      })(),
      customNames: { '技艺①': '摄影', '外语①': '拉丁语', '科学①': '化学' }
    });
    fillSkillPoints(ch);
    const b = budgetOf(ch);
    if (b.occLeft !== 0 || b.intLeft !== 0) {
      bad++;
      if (badNames.length < 5) badNames.push(`${occ.name}(职业${b.occLeft}/兴趣${b.intLeft})`);
    }
  }
  eq(bad, 0, `225 个职业大面积铺点后账目全平${bad ? '，不平的：' + badNames.join(' ') : ''}`);
}

// ---- 用例：AI 生成的卡在编辑器里打开后，特长名额必须已用满 ----
//
// 用户反馈「AI 生成任务卡不会自己点特长，所以还是会有职业点和兴趣点剩余」。
// fillSkillPoints 阶段 0 会自动补满特长名额（free），这里锁住这个行为：
// 只要职业带 free 名额，生成完就必须正好选满 free 项。
{
  let missing = 0;
  const missingNames = [];
  // 注意：职业表里有重名条目（工匠/艺人/科学家 各出现两次），
  // findOccupation 只会返回第一个，所以这里也要用 findOccupation 取 free，
  // 否则会拿第二个定义的名额去校验第一个定义生成的卡。
  const seen = new Set();
  for (const occ of OCCUPATIONS) {
    if (seen.has(occ.name)) continue;
    seen.add(occ.name);
    const def = findOccupation(occ.name);
    if (!def || !(Number(def.free) > 0)) continue;
    const ch = gen({
      name: '测试', occupation: occ.name, age: 30,
      attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 45, INT: 70, POW: 60, EDU: 75 },
      skills: {}
    });
    fillSkillPoints(ch);
    const picked = (ch.occFreeSkills || []).length;
    if (picked !== Number(def.free)) {
      missing++;
      if (missingNames.length < 5) missingNames.push(`${occ.name}(${picked}/${def.free})`);
    }
  }
  eq(missing, 0, `所有带 free 名额的职业，AI 生成后特长自动选满${missing ? '，未满的：' + missingNames.join(' ') : ''}`);
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
