// ---------------------------------------------------------------------------
// 理智系统 —— COC 7e SAN 规则
// ---------------------------------------------------------------------------
import { rollDice, randInt } from './dice.js';

/** 常见的 SAN 损失组合 */
export const SAN_LOSS_PRESETS = {
  '轻微超自然': '0/1d3',
  '人类尸体/血腥': '0/1d4',
  '超自然恐怖': '1/1d6',
  '看见神话生物': '1/1d8',
  '直视旧日支配者': '1d10/1d100',
  '阅读禁忌典籍': '1/1d6',
  '亲密之人惨死': '1/1d8',
  '自身变形': '1d6/2d10'
};

/** 解析 "0/1d3" 这类 SAN 损失表达式，返回成功损失与失败损失 */
export function parseSanLoss(expr) {
  const parts = String(expr).split('/');
  return {
    onSuccess: parts[0]?.trim() || '0',
    onFailure: parts[1]?.trim() || parts[0]?.trim() || '0'
  };
}

/**
 * 执行一次 SAN 检定
 * @param ch 角色
 * @param lossExpr "0/1d3" 形式
 * @param rollResult d100 结果对象
 * @param successLevelObj 成功等级对象
 */
export function applySanCheck(ch, lossExpr, rollResult, level) {
  const { onSuccess, onFailure } = parseSanLoss(lossExpr);

  // 大成功：不受损失
  if (level.level === 'critical') {
    return {
      loss: 0,
      note: '大成功，理智毫发无伤',
      before: ch.san.current,
      after: ch.san.current,
      bout: false
    };
  }

  // 大失败：取最大损失
  if (level.level === 'fumble') {
    const max = rollDice(onFailure);
    const loss = max.total; // 已是掷出值
    return finishSan(ch, loss, '大失败，理智损失取满额', true);
  }

  const ok = level.ok;
  const expr = ok ? onSuccess : onFailure;
  const rolled = rollDice(expr);
  const loss = Math.max(0, rolled.total);

  return finishSan(ch, loss, ok ? '理智检定成功' : '理智检定失败', false);
}

function finishSan(ch, loss, note, forceBout) {
  const before = ch.san.current;
  ch.san.current = Math.max(0, before - loss);

  // 单次损失 ≥5 点 → 临时疯狂（角色需要 INT 检定）
  const tempMadness = loss >= 5 || forceBout;
  // 累计损失达到当前 SAN 的 1/5 → 永久性疯狂（不定时疯狂）
  const ratio = before > 0 ? loss / before : 0;
  const indefinite = ratio >= 0.2;

  const bout = tempMadness && loss > 0;

  return {
    loss,
    note,
    before,
    after: ch.san.current,
    tempMadness,
    indefinite,
    bout,
    needsIntCheck: bout
  };
}

/** 疯狂发作症状（1d10） */
export const MADNESS_SYMPTOMS = [
  '失忆：回过神来发现自己身处陌生之地，缺失一段时间记忆',
  '假性残疾：坚信自己失明/失聪/失去某肢体，实际完好',
  '暴力倾向：对周围人产生强烈攻击冲动',
  '偏执：坚信所有人都在监视、谋害自己',
  '重要之人：把某个陌生人误认为逝去/重要的人',
  '昏厥：当场失去意识',
  '恐慌逃离：不顾一切地想要离开当前场所',
  '恐惧症：获得一个新的恐惧症',
  '躁狂：陷入某种强迫性行为（反复洗手、计数等）',
  '幻觉：看见/听见并不存在的东西'
];

export function rollMadnessSymptom() {
  const n = randInt(1, 10);
  return { roll: n, symptom: MADNESS_SYMPTOMS[n - 1] };
}

/** 恐惧症表（简化） */
export const PHOBIAS = [
  '恐高症', '幽闭恐惧症', '蜘蛛恐惧症', '血液恐惧症', '黑暗恐惧症',
  '深海恐惧症', '火焰恐惧症', '人群恐惧症', '尸体恐惧症', '镜子恐惧症',
  '尖锐物恐惧症', '活埋恐惧症', '蛇类恐惧症', '噪音恐惧症', '污秽恐惧症'
];

/** SAN 归零 → 永久疯狂 */
export function checkInsanity(ch) {
  if (ch.san.current <= 0) {
    ch.status.push('永久疯狂');
    return { insane: true, note: '理智归零，角色永久疯狂，交由 KP 接管或退役。' };
  }
  if (ch.san.current <= 20 && !ch.status.includes('濒临疯狂')) {
    ch.status.push('濒临疯狂');
    return { insane: false, note: 'SAN 低于 20，角色已处于濒临疯狂状态。' };
  }
  return { insane: false, note: '' };
}

/** 理智恢复（精神分析、休养） */
export function recoverSan(ch, amount) {
  ch.san.current = Math.min(ch.san.temp, ch.san.current + amount);
  if (ch.san.current > 20) {
    ch.status = ch.status.filter((s) => s !== '濒临疯狂');
  }
  return ch.san.current;
}

/**
 * 7e 的 SAN 上限规则：技能「克苏鲁神话」每点永久降低 SAN 上限 1
 */
export function syncSanCap(ch) {
  const mythos = ch.skills['克苏鲁神话'] ?? 0;
  const cap = Math.max(0, 99 - mythos);
  ch.san.temp = Math.min(ch.san.temp, cap);
  ch.san.current = Math.min(ch.san.current, cap);
  return cap;
}
