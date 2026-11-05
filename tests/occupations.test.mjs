// ---------------------------------------------------------------------------
// 职业规则与技能点测试
//
// 规则来源：COC7空白卡23（粉）-坪改.xlsx 的「职业列表」「本职技能」两页。
// 这里逐项验证：公式求值、职业查找、本职技能判定、点数账目。
// ---------------------------------------------------------------------------

import { SKILL_DEFS, baseSkillValue, createCharacter } from '../src/core/character.js';
import {
  OCCUPATIONS, SOCIAL_SKILLS, findOccupation, evalOccupationFormula,
  occupationTotal, interestTotal, isOccupationalSkill, skillPointBudget
} from '../src/core/occupations.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.log('  FAIL: ' + name); }
}

function eq(actual, expected, name) {
  ok(actual === expected, `${name} (期待 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)})`);
}

function group(title, fn) {
  console.log('\n== ' + title + ' ==');
  fn();
}

// 一份标准属性，用来算期望值
const ATTRS = { STR: 50, CON: 55, SIZ: 60, DEX: 60, APP: 45, INT: 65, POW: 50, EDU: 70, LUCK: 55 };

// ---------------------------------------------------------------------------
group('职业表完整性', () => {
  ok(OCCUPATIONS.length > 200, `职业数量合理（实际 ${OCCUPATIONS.length}）`);

  // 每条都得有名字、信用评级、点数公式，缺了就算数据坏了
  const broken = OCCUPATIONS.filter((o) => !o.name || !o.credit || !o.pts);
  eq(broken.length, 0, '所有职业都有 name / credit / pts');

  // 属性缩写必须都是我们认识的那几个，否则公式会静默算成 0
  const known = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'LUCK'];
  const badAttr = [];
  for (const o of OCCUPATIONS) {
    for (const m of String(o.pts).matchAll(/([A-Z]{2,3})\*/g)) {
      if (!known.includes(m[1])) badAttr.push(`${o.name}:${m[1]}`);
    }
  }
  eq(badAttr.length, 0, '点数公式只用到已知属性');

  eq(SOCIAL_SKILLS.length, 4, '社交技能候选是 4 个');
});

// ---------------------------------------------------------------------------
group('点数公式求值', () => {
  // 单项属性乘倍数
  eq(evalOccupationFormula('EDU*4', ATTRS), 280, 'EDU*4 → 280');
  eq(evalOccupationFormula('EDU*2+DEX*2', ATTRS), 260, 'EDU*2+DEX*2 → 260');
  eq(evalOccupationFormula('EDU*2+APP*2', ATTRS), 230, 'EDU*2+APP*2 → 230');

  // MAX 取两项里大的那个
  eq(evalOccupationFormula('EDU*2+MAX(STR*2,DEX*2)', ATTRS), 260, 'MAX(STR,DEX) 取 DEX 的 120');
  eq(evalOccupationFormula('EDU*2+MAX(DEX*2,APP*2)', ATTRS), 260, 'MAX(DEX,APP) 取 DEX 的 120');
  eq(evalOccupationFormula('EDU*2+MAX(DEX*2,APP*2,STR*2)', ATTRS), 260, '三项 MAX 取最大');

  // 属性缺失不能炸，按 0 算
  eq(evalOccupationFormula('EDU*4', {}), 0, '属性缺失按 0');
  eq(evalOccupationFormula('', ATTRS), 0, '空公式返回 0');
  eq(evalOccupationFormula(null, ATTRS), 0, 'null 公式返回 0');

  // 空白字符不影响结果
  eq(evalOccupationFormula('EDU * 4', ATTRS), 280, '公式里的空格被忽略');
});

// ---------------------------------------------------------------------------
group('职业查找', () => {
  eq(findOccupation('会计师')?.name, '会计师', '精确匹配');
  ok(findOccupation('侦探') !== null, '简称能匹配到「事务所侦探、保安」');
  ok(findOccupation('演员') !== null, '「演员」能匹配到演员类职业');
  eq(findOccupation('不存在职业'), null, '找不到返回 null');
  eq(findOccupation(''), null, '空字符串返回 null');
  eq(findOccupation(undefined), null, 'undefined 返回 null');
});

// ---------------------------------------------------------------------------
group('点数总额', () => {
  const ch = createCharacter({ name: '测试员' });
  ch.attrs = { ...ATTRS };
  ch.occupation = '会计师';
  eq(occupationTotal(ch), 280, '会计师职业点 = EDU×4');
  eq(interestTotal(ch), 130, '兴趣点 = INT×2');

  // 没填职业时不该算出点数
  ch.occupation = '';
  eq(occupationTotal(ch), 0, '无职业时职业点为 0');

  // 杂技演员 = EDU×2 + DEX×2
  ch.occupation = '杂技演员';
  eq(occupationTotal(ch), 260, '杂技演员职业点 = EDU×2+DEX×2');
});

// ---------------------------------------------------------------------------
group('本职技能判定', () => {
  const ch = createCharacter({ name: '测试员' });
  ch.attrs = { ...ATTRS };
  const noCustom = () => '';

  // 会计师：会计 / 法律 / 图书馆 / 聆听 / 说服 / 侦查
  ch.occupation = '会计师';
  for (const s of ['会计', '法律', '图书馆使用', '聆听', '说服', '侦查']) {
    ok(isOccupationalSkill(ch, s, noCustom), `会计师的本职：${s}`);
  }
  ok(!isOccupationalSkill(ch, '格斗：斗殴', noCustom), '会计师的格斗不算本职');
  ok(!isOccupationalSkill(ch, '话术', noCustom), '会计师没有社交技能要求，话术不算本职');

  // 演员-戏剧演员：要求 2 项社交技能 → 四个社交技能都算本职候选
  ch.occupation = '演员-戏剧演员';
  for (const s of SOCIAL_SKILLS) {
    ok(isOccupationalSkill(ch, s, noCustom), `戏剧演员的社交候选：${s}`);
  }
  ok(!isOccupationalSkill(ch, '侦查', noCustom), '戏剧演员的侦查不算本职');

  // 任意特长：玩家自填了具体名字的技能算本职
  ch.occupation = '会计师';
  ch.customNames = { '技艺①': '摄影' };
  ok(isOccupationalSkill(ch, '技艺①', (n) => ch.customNames[n] || ''),
    '填了名字的任意特长算本职');
  ok(!isOccupationalSkill(ch, '技艺①', noCustom),
    '没填名字的任意特长不算本职');

  // 无职业时什么都不算本职
  ch.occupation = '';
  ok(!isOccupationalSkill(ch, '会计', noCustom), '无职业时没有本职技能');
});

// ---------------------------------------------------------------------------
group('点数账目', () => {
  const ch = createCharacter({ name: '测试员' });
  ch.attrs = { ...ATTRS };
  ch.occupation = '会计师';

  const baseOf = (n) => {
    const def = SKILL_DEFS.find((d) => d.name === n);
    return def ? baseSkillValue(def, ch.attrs) : 0;
  };
  const isOcc = (n) => isOccupationalSkill(ch, n, (x) => ch.customNames?.[x] || '');

  // 会计 5→70 用 65，侦查 25→65 用 40，聆听 20→50 用 30，都是本职
  ch.skills['会计'] = 70;
  ch.skills['侦查'] = 65;
  ch.skills['聆听'] = 50;
  // 格斗 25→60 用 35，非本职 → 走兴趣点
  ch.skills['格斗：斗殴'] = 60;

  const b = skillPointBudget(ch, baseOf, isOcc);
  eq(b.occTotal, 280, '职业点总额');
  eq(b.occUsed, 135, '职业点已用 = 65+40+30');
  eq(b.occLeft, 145, '职业点剩余');
  eq(b.intTotal, 130, '兴趣点总额');
  eq(b.intUsed, 35, '兴趣点已用');
  eq(b.intLeft, 95, '兴趣点剩余');

  // 技能只等于初始值时不该算已用点
  const fresh = createCharacter({ name: '新人' });
  fresh.attrs = { ...ATTRS };
  fresh.occupation = '会计师';
  const b2 = skillPointBudget(fresh,
    (n) => { const d = SKILL_DEFS.find((x) => x.name === n); return d ? baseSkillValue(d, fresh.attrs) : 0; },
    (n) => isOccupationalSkill(fresh, n, () => ''));
  eq(b2.occUsed, 0, '未加点时职业点已用为 0');
  eq(b2.intUsed, 0, '未加点时兴趣点已用为 0');

  // 技能值低于初始值（手改低了）不能算负数已用
  const low = createCharacter({ name: '手改' });
  low.attrs = { ...ATTRS };
  low.occupation = '会计师';
  low.skills['会计'] = 3; // 低于基础 5
  const b3 = skillPointBudget(low,
    (n) => { const d = SKILL_DEFS.find((x) => x.name === n); return d ? baseSkillValue(d, low.attrs) : 0; },
    (n) => isOccupationalSkill(low, n, () => ''));
  eq(b3.occUsed, 0, '技能值低于初始值时不计负点');

  // 超支要能算出负数
  const over = createCharacter({ name: '超支' });
  over.attrs = { ...ATTRS };
  over.occupation = '会计师';
  over.skills['会计'] = 99;
  over.skills['侦查'] = 99;
  over.skills['聆听'] = 99;
  over.skills['法律'] = 99;
  const b4 = skillPointBudget(over,
    (n) => { const d = SKILL_DEFS.find((x) => x.name === n); return d ? baseSkillValue(d, over.attrs) : 0; },
    (n) => isOccupationalSkill(over, n, () => ''));
  ok(b4.occLeft < 0, `超支时剩余为负（实际 ${b4.occLeft}）`);
});

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(40));
console.log(`通过 ${passed} 项，失败 ${failed} 项，共 ${passed + failed} 项`);
if (failed) { for (const f of failures) console.log(' - ' + f); process.exit(1); }
console.log('全部通过');
