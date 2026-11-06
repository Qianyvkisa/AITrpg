// ---------------------------------------------------------------------------
// 角色卡生成：让 AI 按 COC 7e 规则造一张完整的调查员卡
//
// 输出结构与 character.js 的字段对齐，解析后直接交给 normalizeCharacter 兜底。
// ---------------------------------------------------------------------------
import {
  ATTRS, SKILL_DEFS, createCharacter, refreshDerived, rollAttributes,
  baseSkillValue, normalizeCharacter
} from '../core/character.js';
import { isOccupationalSkill, skillPointBudget } from '../core/occupations.js';

/** 生成角色卡时的输出上限。一张完整卡（含技能与背景）约 1200-2000 token */
export const CHAR_MAX_TOKENS = 3000;

/** 所有可填技能名（不含自定义子类，避免 AI 瞎编子技能） */
function skillNameList() {
  return SKILL_DEFS.filter((s) => !s.custom || s.name === '自定义技能').map((s) => s.name);
}

/**
 * 组装生成角色卡的提示词。
 *
 * @param {{brief?: string, occupation?: string, era?: string, tone?: string,
 *          role?: 'player'|'teammate', existingNames?: string[], seedAttrs?: object}} opts
 */
export function buildCharPrompt({
  brief = '', occupation = '', era = '1920s', tone = '经典恐怖',
  role = 'player', existingNames = [], seedAttrs = null
} = {}) {
  const attrLine = ATTRS.map((a) => `${a.name}(${a.key})`).join('、');
  const skillList = skillNameList().join('、');

  const sys = `你是《克苏鲁的呼唤》第 7 版的资深玩家，擅长按规则车出一张能直接上桌的调查员卡。

要求：
1. 严格遵守 7e 生成规则：属性用 3d6×5（SIZ/INT/EDU 用 (2d6+6)×5），数值范围 15~90，个位数为 0 或 5。
2. 技能值 = 初始值 + 职业点 + 兴趣点，单技能不超过 90（个别可到 99）。
   **必须把点数花完**：职业点总额 = 职业公式（如 EDU×4），兴趣点总额 = 智力×2。
   先给本职技能加点直到花完职业点，再用兴趣点抬其他技能，别只加几项就停手。
   注意：写进 "skills" 的是**最终值**（已含初始值），不是加点数。
   克苏鲁神话例外：车卡阶段它必须是 0，不许分配任何点数（原版规则只能靠游戏内遭遇增长）。
3. 职业要贴合时代与基调；技能分配要符合职业身份，别平均撒点。
4. 背景故事（形象描述、思想与信念、重要之人、意义非凡之地、宝贵之物、特质、伤口疤痕、恐惧症）要具体、有人味，别写套话。
5. 输出必须是严格 JSON，不要有任何多余文字、不要包在代码块里。

JSON 结构：
{
  "name": "姓名（中文，符合时代与地域）",
  "gender": "性别",
  "age": 年龄数字,
  "occupation": "职业",
  "hometown": "故乡",
  "residence": "住地",
  "era": "时代",
  "attrs": {"STR":数字,"CON":数字,"SIZ":数字,"DEX":数字,"APP":数字,"INT":数字,"POW":数字,"EDU":数字,"LUCK":数字},
  "skills": {"技能名":数字},
  "customNames": {"技艺①":"具体技艺名","外语①":"具体语言","科学①":"具体学科"},
  "weapons": [{"name":"武器名","skill":"使用技能","damage":"伤害","range":"射程"}],
  "inventory": ["随身物品"],
  "assets": {"creditRating":数字,"livingStandard":"生活水平","cash":数字},
  "background": {
    "description":"外貌与形象描述",
    "ideology":"思想与信念",
    "significantPeople":"重要之人",
    "meaningfulLocations":"意义非凡之地",
    "treasuredPossessions":"宝贵之物",
    "traits":"特质",
    "wounds":"伤口和疤痕",
    "phobias":"恐惧症和躁狂症",
    "story":"一段完整的背景故事（150-300字）"
  },
  "persona": "给 KP 看的一句话性格概括"
}

属性键必须用：${attrLine}
技能名必须从这份清单里选（不要自创）：${skillList}
"skills" 里没写的技能按初始值算，写了的就是最终值（含初始值）。`;

  const parts = [
    `时代：${era}`,
    `基调：${tone}`,
    role === 'player' ? '这张卡是玩家自己扮演的调查员。' : '这张卡是 AI 扮演的队友 NPC。'
  ];
  if (occupation) parts.push(`指定职业：${occupation}（必须用这个职业）`);
  if (brief) parts.push(`玩家对这个角色的要求：${brief}`);
  if (seedAttrs) {
    parts.push(`属性已经骰好了，必须原样使用，不要改：${JSON.stringify(seedAttrs)}`);
  }
  if (existingNames.length) {
    parts.push(`队伍里已有的角色名：${existingNames.join('、')}。新角色不能重名。`);
  }
  parts.push('请生成这张角色卡。');

  return { sys, user: parts.join('\n') };
}

/**
 * 从 AI 返回的文本里抠出 JSON 并规范化成角色卡。
 * 复用模组导入那套「截断修复」思路：逐级回退到能解析的位置。
 */
export function parseCharJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const tryParse = (str) => {
    try {
      const o = JSON.parse(str);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (_) { return null; }
  };

  // 1) 直接解析
  let obj = tryParse(s);

  // 2) 代码块
  if (!obj) {
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParse(fence[1].trim());
  }

  // 3) 第一个 { 到最后一个 }
  if (!obj) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(s.slice(a, b + 1));
  }

  // 4) 被截断：逐级砍掉尾部再补括号
  if (!obj) {
    const start = s.indexOf('{');
    if (start >= 0) {
      let body = s.slice(start);
      // 去掉未闭合代码块标记
      body = body.replace(/```[\s\S]*$/, '');
      for (let cut = body.length; cut > 20; cut--) {
        // 只在引号外/逗号处尝试，减少无谓循环
        const ch = body[cut - 1];
        if (ch !== ',' && ch !== '"' && ch !== '}' && ch !== ']') continue;
        let head = body.slice(0, cut).replace(/[,:\s]+$/, '');
        head = head.replace(/,\s*"[^"]*"\s*:\s*$/, '');
        head = head.replace(/,\s*"[^"]*"\s*$/, '');
        const depth = countDepth(head);
        head += '}'.repeat(Math.max(0, depth.brace)) + ']'.repeat(Math.max(0, depth.bracket));
        const r = tryParse(head);
        if (r) { obj = r; break; }
      }
    }
  }

  if (!obj) return null;

  // 字段名容错：AI 偶尔会用别的键
  const pick = (...keys) => {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  };

  const raw = {
    name: pick('name', '姓名', 'charName'),
    gender: pick('gender', 'sex', '性别'),
    age: pick('age', '年龄'),
    occupation: pick('occupation', '职业', 'job'),
    hometown: pick('hometown', '故乡'),
    residence: pick('residence', '住地', '地址'),
    era: pick('era', '时代'),
    attrs: pick('attrs', 'attributes', '属性'),
    skills: pick('skills', '技能'),
    customNames: pick('customNames', 'customSkills', '自定义技能名'),
    weapons: pick('weapons', '武器'),
    inventory: pick('inventory', 'items', '随身物品'),
    assets: pick('assets', '资产'),
    background: pick('background', '背景', 'bg'),
    persona: pick('persona', '性格', 'personality')
  };

  return raw;
}

/** 统计未闭合的括号数量（忽略字符串内的） */
function countDepth(str) {
  let brace = 0, bracket = 0, inStr = false, esc = false;
  for (const c of str) {
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
  }
  return { brace, bracket };
}

/**
 * 把 AI 的原始输出变成一张可用的角色卡。
 *
 * @param {object} raw parseCharJson 的结果
 * @param {{name?: string, isPlayer?: boolean, existingNames?: string[]}} opts
 * @returns {object} 角色卡（已 refreshDerived）
 */
export function charFromAI(raw, { name, isPlayer = false, existingNames = [] } = {}) {
  const ch = createCharacter({ name: '调查员', isPlayer });

  // ---- 基本信息 ----
  ch.name = (name || raw.name || '').toString().trim().slice(0, 20) || '调查员';
  // 重名兜底
  if (existingNames.includes(ch.name)) {
    let i = 2;
    while (existingNames.includes(`${ch.name}${i}`) && i < 20) i++;
    ch.name = `${ch.name}${i}`;
  }
  if (raw.gender) ch.gender = String(raw.gender).slice(0, 10);
  if (raw.occupation) ch.occupation = String(raw.occupation).slice(0, 20);
  if (raw.hometown) ch.hometown = String(raw.hometown).slice(0, 30);
  if (raw.residence) ch.residence = String(raw.residence).slice(0, 30);
  if (raw.era) ch.era = String(raw.era).slice(0, 20);
  if (raw.persona) ch.persona = String(raw.persona).slice(0, 200);

  const age = Number(raw.age);
  if (Number.isFinite(age) && age >= 15 && age <= 90) ch.age = Math.floor(age);

  // ---- 属性：夹到合法范围，并归整到 5 的倍数 ----
  if (raw.attrs && typeof raw.attrs === 'object') {
    for (const a of ATTRS) {
      const v = Number(raw.attrs[a.key] ?? raw.attrs[a.name]);
      if (Number.isFinite(v) && v > 0) {
        ch.attrs[a.key] = Math.max(1, Math.min(99, Math.round(v / 5) * 5 || 5));
      }
    }
  } else {
    // AI 没给属性就自己骰
    ch.attrs = rollAttributes();
  }

  // ---- 自定义子技能名 ----
  if (raw.customNames && typeof raw.customNames === 'object') {
    for (const [k, v] of Object.entries(raw.customNames)) {
      if (v) ch.customNames[k] = String(v).slice(0, 20);
    }
  }

  refreshDerived(ch);

  // ---- 技能：以初始值为底，覆盖 AI 给的值 ----
  const validNames = new Set(SKILL_DEFS.map((d) => d.name));
  if (raw.skills && typeof raw.skills === 'object') {
    for (const [k, v] of Object.entries(raw.skills)) {
      const key = String(k).trim();
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (validNames.has(key)) {
        // 克苏鲁神话不能高于 99，其他夹到 99
        ch.skills[key] = Math.max(0, Math.min(99, Math.round(n)));
      }
    }
  }
  // 闪避/母语由属性决定初始值，但 AI 可以在此基础上加点（这属于正常花点，
  // 编辑器里同样允许）。这里只保证不低于初始值，不能把加点抹掉——
  // 之前直接赋值等于每次生成都吞掉 AI 给这两项加的点。
  ch.skills['闪避'] = Math.max(ch.skills['闪避'] || 0, Math.floor(ch.attrs.DEX / 2));
  ch.skills['母语'] = Math.max(ch.skills['母语'] || 0, ch.attrs.EDU);
  // 克苏鲁神话在车卡阶段恒为 0：原版规则不给加点，只能靠游戏内遭遇增长。
  // 之前这里写的是 Math.min(x, 5)，等于允许 AI 塞 5 点，与规则不符。
  ch.skills['克苏鲁神话'] = 0;

  // ---- 派生状态填满 ----
  ch.hp.current = ch.hp.max;
  ch.mp.current = ch.mp.max;
  ch.san.current = ch.san.max;
  ch.san.temp = ch.san.max;
  ch.luck.current = ch.attrs.LUCK;

  // ---- 武器 ----
  if (Array.isArray(raw.weapons)) {
    ch.weapons = raw.weapons
      .filter((w) => w && (w.name || w.武器名))
      .slice(0, 6)
      .map((w) => ({
        name: String(w.name ?? w.武器名 ?? '').slice(0, 20),
        skill: String(w.skill ?? w.使用技能 ?? '格斗：斗殴').slice(0, 20),
        damage: String(w.damage ?? w.伤害 ?? '').slice(0, 20),
        range: String(w.range ?? w.射程 ?? '').slice(0, 20)
      }));
  }

  // ---- 随身物品 ----
  if (Array.isArray(raw.inventory)) {
    ch.inventory = raw.inventory
      .filter((x) => x && typeof x === 'string')
      .slice(0, 20)
      .map((x) => x.slice(0, 40));
  }

  // ---- 资产 ----
  if (raw.assets && typeof raw.assets === 'object') {
    const cr = Number(raw.assets.creditRating ?? raw.assets.信用评级);
    if (Number.isFinite(cr)) ch.assets.creditRating = Math.max(0, Math.min(99, Math.round(cr)));
    if (raw.assets.livingStandard ?? raw.assets.生活水平) {
      ch.assets.livingStandard = String(raw.assets.livingStandard ?? raw.assets.生活水平).slice(0, 30);
    }
    const cash = Number(raw.assets.cash ?? raw.assets.现金);
    if (Number.isFinite(cash)) ch.assets.cash = Math.max(0, Math.round(cash));
  }

  // ---- 背景 ----
  if (raw.background && typeof raw.background === 'object') {
    const map = {
      description: ['description', '形象描述', '外貌'],
      ideology: ['ideology', '思想与信念', '信念'],
      significantPeople: ['significantPeople', '重要之人'],
      meaningfulLocations: ['meaningfulLocations', '意义非凡之地'],
      treasuredPossessions: ['treasuredPossessions', '宝贵之物'],
      traits: ['traits', '特质'],
      wounds: ['wounds', '伤口和疤痕'],
      phobias: ['phobias', '恐惧症'],
      story: ['story', '背景故事']
    };
    for (const [key, aliases] of Object.entries(map)) {
      for (const al of aliases) {
        const v = raw.background[al];
        if (v) { ch.background[key] = String(v).slice(0, 800); break; }
      }
    }
  }

  return normalizeCharacter(ch);
}

/**
 * 把 AI 没花完的技能点补满。
 *
 * 为什么要补：
 *   AI 生成卡时只挑几项「看起来符合人设」的技能加个三四十点，剩下大量点数
 *   不花。实测三张典型卡平均浪费 47% 的预算，兴趣点甚至只用了 13%。
 *   技能点没花完的卡在跑团里是实打实的弱，玩家还得手动补齐——那 AI 车卡
 *   就没意义了。所以生成后统一把余额按规则补到该用的地方。
 *
 * 补点顺序（尽量贴近真人车卡习惯）：
 *   1) 本职技能优先：AI 已经加过的本职技能继续往上抬，符合职业画像
 *   2) 本职技能里 AI 没碰过的，也按职业给的固定项补
 *   3) 兴趣点：优先抬 AI 已经表现出兴趣的技能（说明它认为这角色擅长这些）
 *   4) 还不够就按通用实用度补：侦查/聆听/图书馆这类跑团刚需
 *
 * 硬约束：
 *   - 单技能上限：先按 90 铺匀，余额再抬到 99（7e 默认上限就是 99，
 *     「技能等级保险」那条 90 上限属于可选规则，不在这里强制）
 *   - 克苏鲁神话恒为 0，不许补
 *   - 信用评级不占技能点账目（它在资产里单独算），不参与补点
 *   - 闪避/母语可以加点，但已经在前面按属性兜过底了
 *
 * @param {object} ch 已 refreshDerived 的角色卡（会被就地修改）
 * @returns {object} 同一个 ch
 */
export function fillSkillPoints(ch) {
  const baseOf = (name) => {
    const def = SKILL_DEFS.find((d) => d.name === name);
    return def ? baseSkillValue(def, ch.attrs) : 0;
  };
  const displayOf = (name) => (ch.customNames || {})[name] || '';
  const isOcc = (name) => isOccupationalSkill(ch, name, displayOf);

  // 这些技能不参与补点
  const EXCLUDED = new Set(['克苏鲁神话', '信用评级', '自定义技能']);

  // 单技能绝对上限（7e 默认就是 99）
  const HARD_CAP = 99;

  /**
   * 先削掉超支。
   *
   * AI 有时会把技能堆得很高，职业点直接超支（实测出现过预算 200、实际
   * 花了 450 的卡）。这种情况不能靠"补点"解决——补点只会让账目更难看。
   * 这里把超出的部分从加得最猛的技能上削回来，削到刚好不超为止。
   *
   * 只削「超过初始值」的部分，且不会把技能削到低于初始值。
   */
  const trimOverflow = (budgetNow) => {
    let guard = 0;
    while ((budgetNow.occLeft < 0 || budgetNow.intLeft < 0) && guard < 2000) {
      guard++;
      // 找出当前加点最多的技能，从它身上削 1 点
      const target = budgetNow.occLeft < 0 ? 'occ' : 'int';
      let best = null;
      let bestSpent = 0;
      for (const [name, val] of Object.entries(ch.skills || {})) {
        if (EXCLUDED.has(name)) continue;
        const spent = (Number(val) || 0) - baseOf(name);
        if (spent <= 0) continue;
        const belongsOcc = isOcc(name);
        if ((target === 'occ') !== belongsOcc) continue;
        if (spent > bestSpent) { bestSpent = spent; best = name; }
      }
      if (!best) break;
      ch.skills[best] = (Number(ch.skills[best]) || 0) - 1;

      // 重算账目
      budgetNow = skillPointBudget(ch, baseOf, isOcc);
    }
    return budgetNow;
  };

  let budget = skillPointBudget(ch, baseOf, isOcc);
  if (budget.occLeft < 0 || budget.intLeft < 0) {
    budget = trimOverflow(budget);
  }

  // 职业查不到时 occTotal 为 0，此时只补兴趣点，不凭空造职业点
  let occLeft = Math.max(0, budget.occLeft);
  let intLeft = Math.max(0, budget.intLeft);

  /**
   * 给某个技能加点，返回实际用掉的点数。
   * cap 是这次允许推到的上限：先用 90 铺匀，剩的再用 99 收尾。
   */
  const addTo = (name, want, cap = 90) => {
    if (want <= 0 || EXCLUDED.has(name)) return 0;
    const def = SKILL_DEFS.find((d) => d.name === name);
    if (!def) return 0;
    const cur = Number(ch.skills[name] ?? baseOf(name)) || 0;
    const room = Math.max(0, Math.min(cap, HARD_CAP) - cur);
    const add = Math.min(want, room);
    if (add > 0) ch.skills[name] = cur + add;
    return add;
  };

  // ---- 1) 职业点：先抬 AI 已经加过的本职技能 ----
  // 按当前值从高到低排，优先强化它本来就强的项，符合「专精」直觉
  const occCandidates = SKILL_DEFS
    .filter((d) => !d.custom && !EXCLUDED.has(d.name) && isOcc(d.name))
    .map((d) => ({ name: d.name, cur: Number(ch.skills[d.name] ?? baseOf(d.name)) || 0 }))
    .sort((a, b) => b.cur - a.cur);

  /**
   * 每轮给每个候选分一点，轮流抬，避免把点全砸在第一项。
   * 返回没用完的余额。
   */
  const spread = (candidates, points, cap = 90) => {
    let left = points;
    let guard = 0;
    while (left > 0 && guard < 2000) {
      guard++;
      let progressed = false;
      for (const c of candidates) {
        if (left <= 0) break;
        const used = addTo(c.name, 1, cap);
        if (used > 0) { left -= used; progressed = true; }
      }
      if (!progressed) break; // 全都顶到上限了，剩下的补不进去
    }
    return left;
  };

  // 两阶段：先用 90 把点数铺匀（这样不会造出单项 99 的怪物卡），
  // 若还有余额再用 99 收尾，尽量别让卡带着未分配点进游戏。
  occLeft = spread(occCandidates, occLeft, 90);
  if (occLeft > 0) occLeft = spread(occCandidates, occLeft, 99);

  // ---- 2) 兴趣点：先抬 AI 已经碰过的非本职技能 ----
  const intCandidates = SKILL_DEFS
    .filter((d) => !d.custom && !EXCLUDED.has(d.name) && !isOcc(d.name))
    .map((d) => ({
      name: d.name,
      cur: Number(ch.skills[d.name] ?? baseOf(d.name)) || 0,
      touched: Number(ch.skills[d.name] ?? baseOf(d.name)) > baseOf(d.name)
    }))
    // AI 加过的排前面；同组内按当前值高低
    .sort((a, b) => (b.touched - a.touched) || (b.cur - a.cur));

  intLeft = spread(intCandidates, intLeft, 90);
  if (intLeft > 0) intLeft = spread(intCandidates, intLeft, 99);

  return ch;
}

/**
 * 调 AI 生成一张角色卡。
 *
 * @param {{baseUrl,apiKey,model,temperature?,maxTokens?}} apiConfig
 * @param {{brief?, occupation?, era?, tone?, role?, existingNames?, seedAttrs?}} opts
 * @param {{chat: Function}} api 注入的 chat 函数（便于测试）
 */
export async function generateCharacter(apiConfig, opts = {}, api) {
  const { sys, user } = buildCharPrompt(opts);

  const res = await api.chat({
    ...apiConfig,
    temperature: 0.9,
    maxTokens: CHAR_MAX_TOKENS,
    stream: false,
    purpose: 'charGen',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ]
  });

  if (!res.ok) return { ok: false, error: res.error || 'AI 调用失败' };

  const raw = parseCharJson(res.text);
  if (!raw) {
    return {
      ok: false,
      error: 'AI 没有返回合法的角色卡 JSON（可能是输出被截断或模型不支持 JSON 输出）',
      text: res.text
    };
  }

  const ch = charFromAI(raw, {
    isPlayer: opts.role !== 'teammate',
    existingNames: opts.existingNames || []
  });

  // AI 通常不会把技能点花完，生成后统一补齐，否则卡会明显偏弱
  fillSkillPoints(ch);

  return { ok: true, char: ch, raw };
}

/** 给界面用的「一键随机」：不走 AI，纯本地骰一张能用的卡 */
export function randomCharacter({ name, isPlayer = false, occupation = '', persona = '' } = {}) {
  const ch = createCharacter({ name: name || '调查员', isPlayer });
  ch.attrs = rollAttributes();
  if (occupation) ch.occupation = occupation;
  if (persona) ch.persona = persona;
  refreshDerived(ch);

  ch.hp.current = ch.hp.max;
  ch.mp.current = ch.mp.max;
  ch.san.current = ch.san.max;
  ch.san.temp = ch.san.max;
  ch.luck.current = ch.attrs.LUCK;

  // 按职业点把技能抬起来：优先抬职业相关技能
  const points = ch.attrs.EDU * 4;
  const preferred = ['侦查', '聆听', '图书馆使用', '心理学', '话术', '说服', '潜行', '急救', '医学', '神秘学'];
  let left = points;
  for (const s of preferred) {
    if (left <= 0) break;
    const add = Math.min(left, 40);
    ch.skills[s] = Math.min(90, (ch.skills[s] || 0) + add);
    left -= add;
  }

  return normalizeCharacter(ch);
}
