// ---------------------------------------------------------------------------
// 规则引擎单元测试 —— 不依赖任何测试框架，直接 node tests/rules.test.mjs
// ---------------------------------------------------------------------------

import { rollDice, rollD100, successLevel, opposedRoll } from '../src/core/dice.js';
import { derive, createCharacter, refreshDerived, rollAttributes, occupationPoints, cloneCharacter } from '../src/core/character.js';
import { parseSanLoss, applySanCheck, checkInsanity, recoverSan, syncSanCap } from '../src/core/sanity.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.log('  FAIL: ' + name); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name + ' (期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + ')');
}

function group(title, fn) {
  console.log('\n== ' + title + ' ==');
  fn();
}
// ---------------------------------------------------------------------------
// 骰子引擎
// ---------------------------------------------------------------------------
group('rollDice 表达式解析', () => {
  const r1 = rollDice('3d6');
  ok(r1.rolls.length === 3, '3d6 掷 3 次');
  ok(r1.total >= 3 && r1.total <= 18, '3d6 结果在 3-18');

  const r2 = rollDice('1d10+2');
  ok(r2.total >= 3 && r2.total <= 12, '1d10+2 结果在 3-12');
  eq(r2.mod, 2, '1d10+2 修正值');

  const r3 = rollDice('2d6-1');
  ok(r3.total >= 1 && r3.total <= 11, '2d6-1 结果在 1-11');
  eq(r3.mod, -1, '2d6-1 修正值');

  const r4 = rollDice('5');
  eq(r4.total, 5, '纯数字按常量处理');
  eq(r4.rolls.length, 0, '纯数字无掷骰记录');

  const r5 = rollDice('d100');
  ok(r5.rolls.length === 1, '省略骰数时默认 1');

  ok(rollDice('abc').total === 0, '非法表达式返回 0');
});

group('rollD100 范围与奖励惩罚骰', () => {
  let inRange = true;
  for (let i = 0; i < 500; i++) {
    const r = rollD100();
    if (r.value < 1 || r.value > 100) { inRange = false; break; }
  }
  ok(inRange, 'd100 500 次结果均在 1-100');

  let found100 = false;
  for (let i = 0; i < 3000; i++) {
    if (rollD100().value === 100) { found100 = true; break; }
  }
  ok(found100, 'd100 能掷出 100');

  const bonus = rollD100({ bonus: 1 });
  eq(bonus.candidates.length, 2, '1 个奖励骰产生 2 个候选');
  eq(bonus.value, Math.min(...bonus.candidates), '奖励骰取最小候选');
  ok(bonus.value >= 1 && bonus.value <= 100, '奖励骰结果在范围内');
  ok(/奖励骰/.test(bonus.bonusPenaltyLabel), '奖励骰标签正确');

  const bonus2 = rollD100({ bonus: 2 });
  eq(bonus2.candidates.length, 3, '2 个奖励骰产生 3 个候选');

  const penalty = rollD100({ penalty: 1 });
  eq(penalty.candidates.length, 2, '1 个惩罚骰产生 2 个候选');
  eq(penalty.value, Math.max(...penalty.candidates), '惩罚骰取最大候选');
  ok(/惩罚骰/.test(penalty.bonusPenaltyLabel), '惩罚骰标签正确');

  const both = rollD100({ bonus: 1, penalty: 2 });
  eq(both.candidates.length, 3, '奖励与惩罚同时存在时取较大者');
});

group('successLevel 成功等级判定', () => {
  eq(successLevel(1, 50).level, 'critical', '掷出 1 是大成功');
  eq(successLevel(1, 50).rank, 4, '大成功 rank=4');
  ok(successLevel(1, 50).ok, '大成功标记成功');

  eq(successLevel(10, 50).level, 'extreme', '≤技能/5 是极难成功');
  eq(successLevel(10, 50).rank, 3, '极难成功 rank=3');

  eq(successLevel(25, 50).level, 'hard', '≤技能/2 是困难成功');
  eq(successLevel(25, 50).rank, 2, '困难成功 rank=2');

  eq(successLevel(50, 50).level, 'regular', '≤技能 是常规成功');
  eq(successLevel(50, 50).rank, 1, '常规成功 rank=1');

  eq(successLevel(51, 50).level, 'failure', '超过技能是失败');
  eq(successLevel(51, 50).rank, 0, '失败 rank=0');
  ok(!successLevel(51, 50).ok, '失败标记不成功');

  eq(successLevel(96, 50).level, 'fumble', '技能≥50 时 96 是大失败');
  eq(successLevel(100, 50).level, 'fumble', '技能≥50 时 100 是大失败');
  eq(successLevel(96, 50).rank, -1, '大失败 rank=-1');

  eq(successLevel(96, 40).level, 'failure', '技能<50 时 96 只是失败');
  eq(successLevel(100, 40).level, 'fumble', '技能<50 时 100 才是大失败');

  eq(successLevel(1, 0).level, 'critical', '技能 0 掷出 1 仍是大成功');
  eq(successLevel(50, 0).level, 'failure', '技能 0 掷 50 失败');
  eq(successLevel(100, 0).level, 'fumble', '技能 0 掷 100 大失败');

  eq(successLevel(20, 100).level, 'extreme', '技能 100 掷 20 是极难成功');
  eq(successLevel(50, 100).level, 'hard', '技能 100 掷 50 是困难成功');
  eq(successLevel(100, 100).level, 'fumble', '技能 100 掷 100 仍是大失败');

  eq(successLevel(50, 150).level, 'hard', '技能 150 被夹到 100');
  eq(successLevel(50, -10).level, 'failure', '技能 -10 被夹到 0');
});

group('opposedRoll 对抗检定', () => {
  const mk = (rank, level, skill) => ({ skill, result: { rank, level } });

  eq(opposedRoll(mk(2, 'hard', 50), mk(1, 'regular', 50)).winner, 'attacker', '等级高者胜');
  eq(opposedRoll(mk(1, 'regular', 50), mk(2, 'hard', 50)).winner, 'defender', '等级高者胜(防守方)');
  eq(opposedRoll(mk(1, 'regular', 60), mk(1, 'regular', 40)).winner, 'attacker', '同等级比技能值');
  eq(opposedRoll(mk(1, 'regular', 30), mk(1, 'regular', 40)).winner, 'defender', '同等级比技能值(防守方高)');
  eq(opposedRoll(mk(0, 'failure', 50), mk(0, 'failure', 50)).winner, 'none', '双方都失败则平局');
  eq(opposedRoll(mk(1, 'regular', 50), mk(4, 'critical', 50)).winner, 'defender', '防守方大成功必胜');
  eq(opposedRoll(mk(4, 'critical', 50), mk(1, 'regular', 50)).winner, 'attacker', '攻击方大成功必胜');
  eq(opposedRoll(mk(-1, 'fumble', 50), mk(0, 'failure', 50)).winner, 'defender', '攻击方大失败则防守方胜');
  eq(opposedRoll(mk(0, 'failure', 50), mk(-1, 'fumble', 50)).winner, 'attacker', '防守方大失败则攻击方胜');
});
// ---------------------------------------------------------------------------
// 角色卡
// ---------------------------------------------------------------------------
group('derive 派生值', () => {
  const d = derive({ STR: 50, CON: 50, SIZ: 50, DEX: 50, POW: 50 });
  eq(d.HP, 10, 'HP=(CON+SIZ)/10');
  eq(d.MP, 10, 'MP=POW/5');
  eq(d.SAN, 50, 'SAN=POW');
  eq(d.build, 0, 'STR+SIZ=100 时体格为 0');
  eq(d.db, '0', '体格 0 时伤害加值为 0');
  eq(d.MOV, 9, 'STR、DEX 均≥SIZ 时 MOV=9');

  const d2 = derive({ STR: 30, CON: 50, SIZ: 70, DEX: 40, POW: 60 });
  eq(d2.MOV, 7, 'STR、DEX 均<SIZ 时 MOV=7');
  eq(d2.HP, 12, 'HP 计算正确');
  eq(d2.MP, 12, 'MP 计算正确');
  eq(d2.SAN, 60, 'SAN 计算正确');

  const d3 = derive({ STR: 20, CON: 50, SIZ: 30, DEX: 70, POW: 50 });
  eq(d3.MOV, 8, '其他组合 MOV=8');

  eq(derive({ STR: 20, SIZ: 30, CON: 50, DEX: 50, POW: 50 }).build, -2, 'STR+SIZ≤64 体格 -2');
  eq(derive({ STR: 30, SIZ: 40, CON: 50, DEX: 50, POW: 50 }).build, -1, 'STR+SIZ≤84 体格 -1');
  eq(derive({ STR: 70, SIZ: 60, CON: 50, DEX: 50, POW: 50 }).build, 1, 'STR+SIZ=130 体格 1');
  eq(derive({ STR: 70, SIZ: 60, CON: 50, DEX: 50, POW: 50 }).db, '1d4', '体格 1 伤害加值 1d4');
  eq(derive({ STR: 50, SIZ: 60, CON: 50, DEX: 50, POW: 50 }).build, 0, 'STR+SIZ=110 体格 0');
  eq(derive({ STR: 90, SIZ: 90, CON: 50, DEX: 50, POW: 50 }).build, 2, 'STR+SIZ≤204 体格 2');
  eq(derive({ STR: 90, SIZ: 90, CON: 50, DEX: 50, POW: 50 }).db, '1d6', '体格 2 伤害加值 1d6');

  eq(derive({}).HP, 10, '缺省属性按 50 计算');
});

group('createCharacter 建卡', () => {
  const ch = createCharacter({ name: '测试员', isPlayer: true });
  eq(ch.name, '测试员', '角色名');
  ok(ch.isPlayer, '玩家标记');
  ok(/^pc-/.test(ch.id), 'id 以 pc- 开头');
  ok(ch.id.length > 5, 'id 长度合理');

  eq(ch.hp.max, 10, '初始 HP 上限');
  eq(ch.hp.current, 10, '初始 HP 当前值');
  eq(ch.mp.max, 10, '初始 MP 上限');
  eq(ch.san.max, 50, '初始 SAN 上限');
  eq(ch.san.temp, 50, '初始 SAN 临时上限');
  eq(ch.luck.current, 50, '初始幸运');

  eq(ch.skills['闪避'], 25, '闪避=DEX/2');
  eq(ch.skills['母语'], 50, '母语=EDU');
  eq(ch.skills['侦查'], 25, '侦查基础值 25');
  eq(ch.skills['克苏鲁神话'], 0, '克苏鲁神话初始 0');

  ok(Array.isArray(ch.status), '状态是数组');
  ok(Array.isArray(ch.inventory), '物品是数组');
  eq(ch.persona, '', '性格设定初始为空');

  const ch2 = createCharacter();
  eq(ch2.name, '调查员', '默认角色名');
  ok(!ch2.isPlayer, '默认不是玩家角色');

  ok(createCharacter().id !== createCharacter().id, '角色 id 唯一');
});

group('refreshDerived 派生值同步', () => {
  const ch = createCharacter();
  ch.attrs.CON = 80;
  ch.attrs.SIZ = 60;
  refreshDerived(ch);
  eq(ch.derived.HP, 14, '改属性后 HP 重算');
  eq(ch.hp.max, 14, 'HP 上限同步');
  ok(ch.hp.current <= ch.hp.max, 'HP 当前值不超上限');

  ch.hp.current = 20;
  refreshDerived(ch);
  ok(ch.hp.current <= ch.hp.max, 'HP 当前值被夹到上限');

  ch.attrs.DEX = 60;
  refreshDerived(ch);
  eq(ch.skills['闪避'], 30, '闪避随 DEX 更新');
});

group('rollAttributes 随机属性', () => {
  let allInRange = true;
  for (let i = 0; i < 50; i++) {
    const a = rollAttributes();
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (!(v >= 15 && v <= 90)) { allInRange = false; console.log('  属性 ' + k + '=' + v + ' 超范围'); }
    }
  }
  ok(allInRange, '随机属性 50 轮均在 15-90 范围内');

  const a = rollAttributes();
  const keys = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'LUCK'];
  ok(keys.every((k) => typeof a[k] === 'number'), '九项属性齐全');
});

group('occupationPoints 职业点', () => {
  eq(occupationPoints({ EDU: 50 }), 200, '默认 4 倍 EDU');
  eq(occupationPoints({ EDU: 50 }, 2), 100, '可指定倍数');
});

group('cloneCharacter 深拷贝', () => {
  const ch = createCharacter({ name: 'A' });
  const copy = cloneCharacter(ch);
  copy.name = 'B';
  copy.attrs.STR = 99;
  eq(ch.name, 'A', '改副本不影响原对象（名字）');
  eq(ch.attrs.STR, 50, '改副本不影响原对象（属性）');
  ok(ch !== copy, '副本是新对象');
});
// ---------------------------------------------------------------------------
// 理智系统
// ---------------------------------------------------------------------------
group('parseSanLoss 损失表达式', () => {
  const p = parseSanLoss('0/1d3');
  eq(p.onSuccess, '0', '成功损失');
  eq(p.onFailure, '1d3', '失败损失');

  const p2 = parseSanLoss('1/1d6');
  eq(p2.onSuccess, '1', '成功损失为 1');
  eq(p2.onFailure, '1d6', '失败损失为 1d6');

  const p3 = parseSanLoss('1d10/1d100');
  eq(p3.onSuccess, '1d10', '成功损失可为骰式');
  eq(p3.onFailure, '1d100', '失败损失可为骰式');

  const p4 = parseSanLoss('1d6');
  eq(p4.onSuccess, '1d6', '单段表达式成功损失');
  eq(p4.onFailure, '1d6', '单段表达式失败损失');
});

group('applySanCheck 理智检定', () => {
  const ch = createCharacter();
  const r1 = applySanCheck(ch, '0/1d3', { value: 30 }, successLevel(30, 50));
  ok(r1.loss >= 0, '成功时损失非负');
  eq(r1.before, 50, '记录扣减前 SAN');
  ok(r1.after <= r1.before, 'SAN 不会增加');

  const ch2 = createCharacter();
  const r2 = applySanCheck(ch2, '1/1d6', { value: 1 }, successLevel(1, 50));
  eq(r2.loss, 0, '大成功不损失 SAN');
  eq(r2.after, r2.before, '大成功后 SAN 不变');

  const ch3 = createCharacter();
  const r3 = applySanCheck(ch3, '0/1d3', { value: 80 }, successLevel(80, 50));
  ok(r3.loss >= 0, '失败时损失非负');

  const ch4 = createCharacter();
  ch4.san.current = 2;
  applySanCheck(ch4, '1d10/1d100', { value: 80 }, successLevel(80, 50));
  ok(ch4.san.current >= 0, 'SAN 不会变成负数');
  eq(ch4.san.current, 0, 'SAN 扣到 0 即停');
});

group('checkInsanity 疯狂判定', () => {
  const ch = createCharacter();
  ch.san.current = 0;
  const r1 = checkInsanity(ch);
  ok(r1.insane, 'SAN=0 判定为疯狂');
  ok(ch.status.includes('永久疯狂'), 'SAN=0 标记永久疯狂');

  const ch2 = createCharacter();
  ch2.san.current = 20;
  const r2 = checkInsanity(ch2);
  ok(!r2.insane, 'SAN=20 不是立即疯狂');
  ok(ch2.status.includes('濒临疯狂'), 'SAN≤20 标记濒临疯狂');

  const ch3 = createCharacter();
  const r3 = checkInsanity(ch3);
  ok(!r3.insane, 'SAN 正常不疯狂');
  ok(!ch3.status.includes('濒临疯狂'), 'SAN 正常无濒临疯狂标记');
});

group('recoverSan 理智恢复', () => {
  const ch = createCharacter();
  ch.san.current = 30;
  ch.san.temp = 50;
  eq(recoverSan(ch, 10), 40, '恢复 10 点 SAN');
  eq(recoverSan(ch, 100), 50, '恢复不会超过上限');

  const ch2 = createCharacter();
  ch2.san.current = 15;
  ch2.status.push('濒临疯狂');
  recoverSan(ch2, 10);
  ok(!ch2.status.includes('濒临疯狂'), 'SAN 回到 20 以上清除濒临疯狂');
});

group('syncSanCap 克苏鲁神话降上限', () => {
  // 实现口径：上限 = min(原上限, 99 - 神话技能)，且当前 SAN 同步夹紧
  const ch = createCharacter();
  ch.skills['克苏鲁神话'] = 0;
  eq(syncSanCap(ch), 99, '神话技能 0 时理论上限为 99');
  eq(ch.san.temp, 50, '原上限 50 未被压低');

  const ch2 = createCharacter();
  ch2.skills['克苏鲁神话'] = 60;
  eq(syncSanCap(ch2), 39, '神话技能 60 时理论上限 39');
  eq(ch2.san.temp, 39, '原上限 50 被压到 39');
  ok(ch2.san.current <= ch2.san.temp, '当前 SAN 不超过新上限');

  const ch3 = createCharacter();
  ch3.skills['克苏鲁神话'] = 99;
  eq(syncSanCap(ch3), 0, '神话技能 99 时上限为 0');
  eq(ch3.san.current, 0, '上限 0 时当前 SAN 也被清零');
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(50));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项，共 ' + (passed + failed) + ' 项');
if (failed > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');