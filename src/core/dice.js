// ---------------------------------------------------------------------------
// 骰子引擎 —— COC 7 版
// 所有随机性都在这里发生，AI 永远不掷骰、不编造结果
// ---------------------------------------------------------------------------

/** [min, max] 闭区间随机整数 */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const TERM_RE = /([+-])?(\d+d\d+|\d+|d\d+)/gi;

/**
 * 解析骰子表达式，支持多项求和：
 *   "3d6" / "1d10+2" / "2d6-1" / "1d6+1d4" / "1d6+db"（db 由调用方先展开）
 * 返回 { total, rolls, mod, expr }；无法解析时 total 为 0。
 */
export function rollDice(expr) {
  const src = String(expr).replace(/\s/g, '');
  const terms = [...src.matchAll(TERM_RE)];

  // 必须整体都是合法项，否则按非法表达式处理（保持旧行为）
  const covered = terms.reduce((n, m) => n + m[0].length, 0);
  if (!terms.length || covered !== src.length) {
    const flat = parseInt(expr, 10);
    return { total: isNaN(flat) ? 0 : flat, rolls: [], mod: 0, expr: String(expr) };
  }

  const rolls = [];
  let total = 0;
  let mod = 0;

  for (const m of terms) {
    const sign = m[1] === '-' ? -1 : 1;
    const body = m[2].toLowerCase();
    const dice = body.match(/^(\d*)d(\d+)$/);

    if (dice) {
      const count = dice[1] ? parseInt(dice[1], 10) : 1;
      const sides = parseInt(dice[2], 10);
      for (let i = 0; i < count; i++) {
        const v = randInt(1, sides) * sign;
        rolls.push(v);
        total += v;
      }
    } else {
      const v = parseInt(body, 10) * sign;
      mod += v;
      total += v;
    }
  }

  return { total, rolls, mod, expr: String(expr) };
}

/**
 * 把伤害表达式里的 db 占位符展开成可解析的形式。
 * db 可能是 '-1' / '0' / '1d4' / '2d6' 等。
 *   expandDb('1d6+db', '-1')  → '1d6-1'
 *   expandDb('1d6+db', '1d4') → '1d6+1d4'
 *   expandDb('1d6-db', '-1')  → '1d6+1'
 */
export function expandDb(expr, db) {
  const dbStr = String(db ?? '0').trim();
  const negative = dbStr.startsWith('-');
  const body = dbStr.replace(/^[+-]/, '') || '0';

  return String(expr).replace(/([+-])?\s*db/i, (_full, sign) => {
    const outer = sign === '-' ? -1 : 1;
    const inner = negative ? -1 : 1;
    return (outer * inner < 0 ? '-' : '+') + body;
  });
}

/**
 * 掷 d100，支持奖励骰/惩罚骰。
 * 规则：单位骰只掷一次，十位骰掷 (1+n) 次；奖励骰取最小结果，惩罚骰取最大。
 * 返回 01-100（00+0 视为 100）。
 */
export function rollD100({ bonus = 0, penalty = 0 } = {}) {
  const units = randInt(0, 9);            // 个位 0-9
  const tensCount = 1 + Math.max(bonus, penalty);
  const tensList = [];
  for (let i = 0; i < tensCount; i++) tensList.push(randInt(0, 9));

  const compose = (tens) => {
    const v = tens * 10 + units;
    return v === 0 ? 100 : v;
  };

  const candidates = tensList.map(compose);
  let value;
  if (bonus > 0) {
    value = Math.min(...candidates);       // 奖励骰：取最好（最小）
  } else if (penalty > 0) {
    value = Math.max(...candidates);       // 惩罚骰：取最差（最大）
  } else {
    value = candidates[0];
  }

  return {
    value,
    units,
    tens: tensList,
    candidates,
    bonus,
    penalty,
    bonusPenaltyLabel:
      bonus > 0 ? `奖励骰 ×${bonus}` : penalty > 0 ? `惩罚骰 ×${penalty}` : ''
  };
}

/**
 * 成功等级判定（COC 7e）
 * 1           → 大成功 critical
 * ≤ 技能/5    → 极难成功 extreme
 * ≤ 技能/2    → 困难成功 hard
 * ≤ 技能      → 常规成功 regular
 * 96-100（技能<50 时仅 100）→ 大失败 fumble
 * 其余        → 失败 failure
 */
export function successLevel(roll, skillValue) {
  const skill = Math.max(0, Math.min(100, Math.floor(skillValue)));

  // 大成功：骰出 01
  if (roll === 1) {
    return {
      level: 'critical',
      label: '大成功',
      rank: 4,
      ok: true,
      desc: '出乎意料的完美表现，额外获得线索或额外效果。'
    };
  }

  // 大失败：技能 <50 时只有 100；技能 ≥50 时 96-100
  const fumbleMin = skill < 50 ? 100 : 96;
  if (roll >= fumbleMin) {
    return {
      level: 'fumble',
      label: '大失败',
      rank: -1,
      ok: false,
      desc: '灾难性的失误，通常伴随额外惩罚（掉落、误伤、暴露、武器损坏等）。'
    };
  }

  if (roll <= Math.floor(skill / 5)) {
    return { level: 'extreme', label: '极难成功', rank: 3, ok: true, desc: '近乎完美的成功，获得额外信息。' };
  }
  if (roll <= Math.floor(skill / 2)) {
    return { level: 'hard', label: '困难成功', rank: 2, ok: true, desc: '干净利落的成功。' };
  }
  if (roll <= skill) {
    return { level: 'regular', label: '常规成功', rank: 1, ok: true, desc: '勉强达成目标。' };
  }
  return { level: 'failure', label: '失败', rank: 0, ok: false, desc: '没能达成目标。' };
}

/** 对抗检定：比较成功等级，平局时比较技能值 */
export function opposedRoll(attacker, defender) {
  const a = attacker.result.rank;
  const d = defender.result.rank;
  let winner;
  if (a > d) winner = 'attacker';
  else if (d > a) winner = 'defender';
  else if (a === 0 && d === 0) winner = 'none';
  else winner = attacker.skill >= defender.skill ? 'attacker' : 'defender';

  // 大成功/大失败的特殊处理
  if (attacker.result.level === 'critical') winner = 'attacker';
  if (defender.result.level === 'critical') winner = 'defender';
  if (attacker.result.level === 'fumble') winner = 'defender';
  if (defender.result.level === 'fumble') winner = 'attacker';

  return { winner, attackerRank: a, defenderRank: d };
}
