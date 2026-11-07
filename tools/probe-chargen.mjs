// 临时探针：模拟几种真实 AI 输出，看生成结果哪里是空的
import { charFromAI, fillSkillPoints, parseCharJson } from '../src/services/charGen.js';
import { skillPointBudget, isOccupationalSkill, findOccupation } from '../src/core/occupations.js';
import { SKILL_DEFS, baseSkillValue } from '../src/core/character.js';

const budgetOf = (ch) => {
  const baseOf = (n) => {
    const d = SKILL_DEFS.find((x) => x.name === n);
    return d ? baseSkillValue(d, ch.attrs) : 0;
  };
  const isOcc = (n) => isOccupationalSkill(ch, n, (x) => (ch.customNames || {})[x] || '');
  return skillPointBudget(ch, baseOf, isOcc);
};

// 典型 AI 输出：职业写成表里没有的叫法、漏掉 gender、兴趣点撒得很散
const samples = {
  '缺 gender + 非标准职业': {
    name: '沈砚', occupation: '退伍军人', age: 34,
    attrs: { STR: 65, CON: 60, SIZ: 65, DEX: 55, APP: 50, INT: 60, POW: 65, EDU: 60, LUCK: 45 },
    skills: { '格斗：斗殴': 60, '射击：手枪': 55, '闪避': 40, '母语': 70, '侦查': 45, '急救': 50 },
    customNames: {}, background: {}, assets: {}
  },
  '标准职业 + 有 gender': {
    name: '白露', gender: '女', occupation: '记者', age: 28,
    attrs: { STR: 45, CON: 50, SIZ: 45, DEX: 65, APP: 65, INT: 75, POW: 55, EDU: 70, LUCK: 60 },
    skills: { '侦查': 60, '聆听': 55, '图书馆使用': 65, '话术': 40, '母语': 70, '心理学': 45 },
    customNames: { '技艺①': '摄影' }, background: {}, assets: {}
  },
  'AI 只给了极少技能': {
    name: '无名', occupation: '私家侦探', age: 40,
    attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 60, APP: 55, INT: 65, POW: 60, EDU: 65, LUCK: 50 },
    skills: { '侦查': 50 },
    customNames: {}, background: {}, assets: {}
  }
};

for (const [label, raw] of Object.entries(samples)) {
  const ch = charFromAI(raw, { isPlayer: true });
  const before = budgetOf(ch);
  fillSkillPoints(ch);
  const after = budgetOf(ch);
  const occ = findOccupation(ch.occupation);
  console.log(`\n=== ${label} ===`);
  console.log(`  name=${ch.name} gender=${JSON.stringify(ch.gender)} occupation=${JSON.stringify(ch.occupation)} 表内=${occ ? occ.name : '未识别'}`);
  console.log(`  occTotal=${after.occTotal} occUsed=${after.occUsed} occLeft=${after.occLeft}`);
  console.log(`  intTotal=${after.intTotal} intUsed=${after.intUsed} intLeft=${after.intLeft}`);
  console.log(`  补点前 occLeft=${before.occLeft} intLeft=${before.intLeft}`);
  // 看看兴趣点花到了哪些技能
  const baseOf = (n) => { const d = SKILL_DEFS.find((x) => x.name === n); return d ? baseSkillValue(d, ch.attrs) : 0; };
  const isOcc = (n) => isOccupationalSkill(ch, n, (x) => (ch.customNames || {})[x] || '');
  const intSpent = Object.entries(ch.skills)
    .map(([n, v]) => [n, v - baseOf(n)])
    .filter(([n, s]) => s > 0 && !isOcc(n))
    .sort((a, b) => b[1] - a[1]);
  console.log('  兴趣点去向：' + intSpent.map(([n, s]) => `${n}+${s}`).join(' '));
  const occSpent = Object.entries(ch.skills)
    .map(([n, v]) => [n, v - baseOf(n)])
    .filter(([n, s]) => s > 0 && isOcc(n))
    .sort((a, b) => b[1] - a[1]);
  console.log('  职业点去向：' + occSpent.map(([n, s]) => `${n}+${s}`).join(' '));
}
