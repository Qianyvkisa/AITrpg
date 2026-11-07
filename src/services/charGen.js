// ---------------------------------------------------------------------------
// 角色卡生成：让 AI 按 COC 7e 规则造一张完整的调查员卡
//
// 输出结构与 character.js 的字段对齐，解析后直接交给 normalizeCharacter 兜底。
// ---------------------------------------------------------------------------
import {
  ATTRS, SKILL_DEFS, createCharacter, refreshDerived, rollAttributes,
  baseSkillValue, normalizeCharacter
} from '../core/character.js';
import {
  OCCUPATIONS, SOCIAL_SKILLS, findOccupation, suggestOccupations,
  isOccupationalSkill, skillPointBudget
} from '../core/occupations.js';

/** 生成角色卡时的输出上限。一张完整卡（含技能与背景）约 1200-2000 token */
export const CHAR_MAX_TOKENS = 3000;

/** 所有可填技能名（不含自定义子类，避免 AI 瞎编子技能） */
function skillNameList() {
  return SKILL_DEFS.filter((s) => !s.custom || s.name === '自定义技能').map((s) => s.name);
}

/**
 * 职业名清单（标准名，去重）。
 *
 * 为什么要把 225 个名字塞进提示词：
 *   职业决定「职业点公式」和「本职技能范围」。AI 之前自己编「退伍军人」
 *   「赛博格」这类名字，findOccupation 查不到 → 职业点算成 0 →
 *   AI 加的技能点全部落到兴趣点上，账目直接超支，技能页还会提示
 *   「这个职业不在职业表里」。给清单是唯一能让 AI 输出可识别职业的办法。
 */
function occupationNameList() {
  return [...new Set(OCCUPATIONS.map((o) => o.name))];
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
  const occList = occupationNameList().join('、');

  const sys = `你是《克苏鲁的呼唤》第 7 版的资深玩家，擅长按规则车出一张能直接上桌的调查员卡。

要求：
1. 严格遵守 7e 生成规则：属性用 3d6×5（SIZ/INT/EDU 用 (2d6+6)×5），数值范围 15~90，个位数为 0 或 5。
2. **每个字段都必须填，一个都不许留空**。尤其 "gender"（性别）和 "occupation"（职业）——
   这两个字段漏了，角色卡上就是两个空格子，玩家还得手填。姓名、性别、年龄、职业、
   故乡、住地、时代、persona 全部要有具体内容。
3. "occupation" 必须**原样抄写**下面清单里的一个职业名（一个字都不要改、不要自创、
   不要加「自由」「资深」这类修饰）。清单外的名字会导致职业点无法计算、技能点全部作废。
4. 技能值 = 初始值 + 职业点 + 兴趣点，单技能不超过 90（个别可到 99）。
   **必须把点数花完**：职业点总额 = 该职业的点数公式（如 EDU×4），兴趣点总额 = 智力×2。
   先给本职技能加点直到花完职业点，再用兴趣点抬其他技能，别只加几项就停手。
   注意：写进 "skills" 的是**最终值**（已含初始值），不是加点数。
   克苏鲁神话例外：车卡阶段它必须是 0，不许分配任何点数（原版规则只能靠游戏内遭遇增长）。
5. 技能分配要符合职业身份，**集中在少数几项**上，别平均撒点。
   兴趣点尤其要挑 3~6 项和这个人设真正相关的技能（比如记者抬摄影/话术，
   医生抬急救/精神分析），不要给几十项各加三五点——那样的卡既不像人也没用。
6. 背景故事（形象描述、思想与信念、重要之人、意义非凡之地、宝贵之物、特质、伤口疤痕、恐惧症）要具体、有人味，别写套话。
7. 输出必须是严格 JSON，不要有任何多余文字、不要包在代码块里。

JSON 结构：
{
  "name": "姓名（中文，符合时代与地域）",
  "gender": "性别（必填，男 / 女，或更具体的写法）",
  "age": 年龄数字,
  "occupation": "职业（必须从下面的职业清单里原样选一个）",
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
"skills" 里没写的技能按初始值算，写了的就是最终值（含初始值）。

职业清单（"occupation" 只能从这里原样选一个）：
${occList}`;

  const parts = [
    `时代：${era}`,
    `基调：${tone}`,
    role === 'player' ? '这张卡是玩家自己扮演的调查员。' : '这张卡是 AI 扮演的队友 NPC。'
  ];
  if (occupation) parts.push(`指定职业：${occupation}（必须用这个职业，且必须是职业清单里的原名）`);
  if (brief) parts.push(`玩家对这个角色的要求：${brief}`);
  if (seedAttrs) {
    parts.push(`属性已经骰好了，必须原样使用，不要改：${JSON.stringify(seedAttrs)}`);
  }
  if (existingNames.length) {
    parts.push(`队伍里已有的角色名：${existingNames.join('、')}。新角色不能重名。`);
  }
  parts.push('请生成这张角色卡。再次强调：所有字段都要填满，occupation 必须来自职业清单。');

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
 * 补齐 AI 漏掉/写歪的基本信息。
 *
 * 两个真实 bug：
 *   1) AI 整段漏掉 "gender" —— 角色卡上性别永远是空格子。
 *      性别虽然不影响规则，但它是角色卡上肉眼可见的空白，玩家一看
 *      就觉得「生成坏了」。这里按姓名+背景猜一个，猜不出就写「未注明」。
 *   2) AI 自创职业名（「退伍军人」「赛博格」「电竞选手」）——
 *      findOccupation 查不到 → 职业点 = 0 → AI 加的技能点全落到兴趣点上 →
 *      账目超支，技能页还提示「这个职业不在职业表里」。
 *      这里把名字换成表内的标准职业。
 *
 * 注意：这只在「AI 车卡」这条路径上做。玩家手动填的职业名一律保留原样，
 * 查不到就是查不到（技能页会提示候选），绝不偷偷改玩家写的东西。
 *
 * @param {object} ch  角色卡（就地修改）
 * @param {object} raw AI 原始输出，用于猜性别
 */
function fillMissingBasics(ch, raw) {
  // ---- 性别 ----
  if (!String(ch.gender || '').trim()) {
    ch.gender = guessGender(ch, raw);
  }

  // ---- 职业 ----
  const occRaw = String(ch.occupation || '').trim();
  const hit = occRaw ? findOccupation(occRaw) : null;

  if (hit) {
    // 查得到就**一个字都不改**。
    //
    // findOccupation 认得别名（「退伍军医」→ 队医）和简称（「侦探」→ 私家侦探），
    // 而技能页的账目也是走同一个函数，所以「退伍军医」这种写法既能算出正确的
    // 职业点，又保住了人设味道——没必要为了「规范」把它改成干巴巴的标准名。
    return;
  }

  ch.occupation = pickOccupationForAI(ch, occRaw);
}

/**
 * AI 写了个表外职业名时，替它挑一个表内职业。
 *
 * 两级策略：
 *   1) 名字有近似候选（两字连续重合）→ 只在候选里挑，按技能画像打分。
 *      这样「退伍军人」不会被改成风马牛不相及的职业。
 *   2) 名字完全不沾边（「赛博格」这种）→ 在**全职业表**里按技能画像挑。
 *      名字已经没参考价值了，只能看 AI 到底把点加在哪。
 *
 * 全程用「AI 已分配技能与本职技能的重合度」打分，因为职业决定哪些技能
 * 吃职业点——选错职业会让 AI 加的战斗技能全变成兴趣点，卡直接废掉。
 *
 * @param {object} ch 角色卡
 * @param {string} occRaw AI 原本写的职业名（可能为空）
 * @returns {string} 表内职业名
 */
function pickOccupationForAI(ch, occRaw) {
  const byName = occRaw ? suggestOccupations(occRaw, 5, { strict: true }) : [];

  // 先只在名字近似的候选里挑
  if (byName.length) {
    const picked = bestOccupationBySkills(ch, byName);
    if (picked) return picked;
    // 候选职业一个技能都对不上：名字近似的那个至少不会更离谱
    return byName[0];
  }

  // 名字完全不沾边：全表按技能画像挑
  const picked = bestOccupationBySkills(ch, OCCUPATIONS.map((o) => o.name));
  if (picked) return picked;

  // AI 一个技能都没加：退回一个本职技能泛用的职业
  return pickFallbackOccupation();
}

/**
 * 在候选职业里挑一个和 AI 已分配技能最吻合的。
 *
 * 打分：把候选职业临时套到卡上，看 AI 加过点的技能有多少落在「本职技能」
 * 范围内，按加的点数加权求和。
 *
 * @param {object} ch 角色卡（occupation 会被临时改写后还原）
 * @param {string[]} pool 候选职业名
 * @returns {string|null} 得分最高的职业；全部为 0 分时返回 null
 */
function bestOccupationBySkills(ch, pool) {
  const displayOf = (n) => (ch.customNames || {})[n] || '';

  // AI 实际加过点的技能 → 点数
  const spent = [];
  for (const def of SKILL_DEFS) {
    const cur = Number(ch.skills?.[def.name]) || 0;
    const base = baseSkillValue(def, ch.attrs);
    if (cur > base) spent.push([def.name, cur - base]);
  }
  if (!spent.length) return null;

  const prev = ch.occupation;
  let best = null;
  let bestScore = 0;

  for (const name of pool) {
    ch.occupation = name;
    let score = 0;
    for (const [skill, pts] of spent) {
      if (isOccupationalSkill(ch, skill, displayOf)) score += pts;
    }
    if (score > bestScore) { bestScore = score; best = name; }
  }

  ch.occupation = prev;
  return best;
}

/** 性别兜底：先看 AI 有没有在别处透口风，再按姓名猜，最后写「未注明」 */
function guessGender(ch, raw) {
  const hay = [
    raw?.persona, raw?.background?.description, raw?.background?.story,
    raw?.background?.traits, raw?.brief
  ].filter(Boolean).join(' ');

  // 「她/她的」「他/他的」出现次数多的一方为准
  const she = (hay.match(/她/g) || []).length;
  const he = (hay.match(/他/g) || []).length;
  if (she > he) return '女';
  if (he > she) return '男';

  // 背景故事里常见的自述
  if (/女性|女子|姑娘|女士|母亲|妻子|姐妹/.test(hay)) return '女';
  if (/男性|男子|小伙|先生|父亲|丈夫|兄弟/.test(hay)) return '男';

  // 实在猜不出：写「未注明」，比留空好——留空会被当成「生成失败」
  return '未注明';
}

/**
 * 完全无法识别职业时挑一个兜底职业。
 *
 * 不随机乱挑：优先选「本职技能泛用、任何调查员都能圆过去」的职业，
 * 这样即使 AI 给的职业名离谱，生成出来的卡在技能分配上也说得通。
 *
 * @returns {string} 职业名（保证存在于 OCCUPATIONS 里）
 */
function pickFallbackOccupation() {
  const PREFER = ['记者', '私家侦探', '作家（原作向）', '教授/学者', '图书馆管理员（原作向）'];
  for (const name of PREFER) {
    if (OCCUPATIONS.some((o) => o.name === name)) return name;
  }
  return OCCUPATIONS[0]?.name || '记者';
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

  // ---- 基本信息兜底（性别 / 职业）放到技能写入之后 ----
  // 职业要靠「AI 把点加到哪些技能上」来判定，所以必须等 skills 落库。
  // 这里只先补性别，职业留到下面。

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

  // ---- 基本信息兜底：性别 / 职业绝不能留空 ----
  //
  // 真实 bug：AI 经常整段漏掉 gender，职业也爱自创「退伍军人」「赛博格」
  // 这种表里没有的叫法。前者让角色卡上性别是个空格子，后者更严重——
  // findOccupation 查不到 → 职业点算成 0 → AI 加的技能点全落到兴趣点上 →
  // 账目超支、技能页还提示「这个职业不在职业表里」。
  //
  // 必须放在技能写入之后：职业要靠「AI 把点加到哪些技能上」来反推。
  fillMissingBasics(ch, raw);

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
 * 关于「撒胡椒面」：
 *   早期版本把兴趣点平均摊到每一个非本职技能上，结果一张卡 30 多项技能
 *   每项都加 3~4 点。这种卡既不像真人，实战里也没有一项能过检定——
 *   玩家看到的第一反应就是「这点数分配有问题」。所以现在**限制候选数量**：
 *   先只在前 6 项里分，都顶到上限了才扩到 10 项、14 项。真人车卡也是
 *   集中抬几项，而不是所有技能都摸一下。
 *
 * 硬约束：
 *   - 单技能上限：先按 90 铺匀，余额再抬到 99（7e 默认上限就是 99，
 *     「技能等级保险」那条 90 上限属于可选规则，不在这里强制）
 *   - 克苏鲁神话恒为 0，不许补
 *   - 信用评级不占技能点账目（它在资产里单独算），不参与补点
 *   - 闪避/母语可以加点，但已经在前面按属性兜过底了
 *
 * @param {object} ch 已 refreshDerived 的角色卡（会被就地修改）
 * @param {{exclude?: string[], prefer?: string[]}} [opts]
 *   exclude：这些技能不参与补点。给 randomCharacter 用——那张卡的产品约定是
 *            「闪避恒等于 DEX/2」，不能让补点逻辑把它抬起来。
 *   prefer：优先加点的技能。给 randomCharacter 用，让每次随机出的卡在技能
 *           分布上有差异，而不是同职业永远长一个样。
 * @returns {object} 同一个 ch
 */
export function fillSkillPoints(ch, opts = {}) {
  const baseOf = (name) => {
    const def = SKILL_DEFS.find((d) => d.name === name);
    return def ? baseSkillValue(def, ch.attrs) : 0;
  };
  const displayOf = (name) => (ch.customNames || {})[name] || '';
  const isOcc = (name) => isOccupationalSkill(ch, name, displayOf);

  // 这些技能不参与补点
  const EXCLUDED = new Set(['克苏鲁神话', '信用评级', '自定义技能', ...(opts.exclude || [])]);

  // 偏好技能：排序时给一个提前量，让它们在同等条件下优先拿到点数
  const PREFER = new Set(opts.prefer || []);

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

  /**
   * 分批加宽候选池地分配点数。
   *
   * 从 pool 里取前 6 项分点，若这 6 项都顶到上限还有余额，才扩到 10 项、
   * 14 项…… 这样点数会集中在少数几项上，造出来的卡才像真人车的。
   *
   * @param {Array<{name:string}>} pool 已按优先级排好序的候选
   * @param {number} points 待分配点数
   * @returns {number} 没用完的余额
   */
  const spreadConcentrated = (pool, points) => {
    let left = points;
    // 先窄后宽：6 → 10 → 14 → …，直到池子用尽
    const widths = [6, 10, 14, 20, 28];
    let usedWidth = 0;

    for (const w of widths) {
      if (left <= 0) break;
      if (usedWidth >= pool.length) break;
      const width = Math.min(w, pool.length);
      if (width <= usedWidth) continue;
      const slice = pool.slice(0, width);
      // 第一阶段 90 封顶，避免一开始就造出 99 的单项
      left = spread(slice, left, 90);
      usedWidth = width;
    }

    // 还有余额说明整池都 90 了，再统一推到 99
    if (left > 0) {
      left = spread(pool, left, 99);
    }
    return left;
  };

  // ---- 1) 职业点：先抬 AI 已经加过的本职技能 ----
  //
  // 这里**要带上 custom 槽位**（射击①、格斗①、生存①…）。
  // 士兵、猎人、牛仔这类职业的本职技能大半写在 custom 槽里，
  // 早期版本用 `!d.custom` 把它们全过滤掉，等于这些职业的职业点
  // 只能往「攀爬/急救/机械维修」这类泛用项上堆，完全不像士兵。
  //
  // 社交技能要限量：职业写「选 2 项社交技能」（social: 2）时，
  // isOccupationalSkill 会把 4 项社交技能全判成本职（程序不知道玩家
  // 到底选哪两项，只能都算候选）。但**分配点数时不能 4 项都填**——
  // 实测那样会让每张卡都长着「话术/取悦/恐吓/说服 60+」的脸，
  // 完全不像真人车出来的卡。这里按 social 数量截断。
  const occDef = findOccupation(ch.occupation);
  const socialQuota = Number(occDef?.social) || 0;

  const socialRanked = socialQuota > 0
    ? SKILL_DEFS
      .filter((d) => SOCIAL_SKILLS.includes(d.name))
      .map((d) => {
        const cur = Number(ch.skills[d.name] ?? baseOf(d.name)) || 0;
        return { name: d.name, cur, touched: cur > baseOf(d.name) };
      })
      // AI 已经加过点的优先保住，再按当前值
      .sort((a, b) => (b.touched - a.touched) || (b.cur - a.cur))
      .slice(0, socialQuota)
      .map((x) => x.name)
    : [];
  const socialAllowed = new Set(socialRanked);

  const occCandidates = SKILL_DEFS
    .filter((d) => !EXCLUDED.has(d.name) && isOcc(d.name))
    // 社交技能只留职业允许的那几项
    .filter((d) => socialQuota <= 0 || !SOCIAL_SKILLS.includes(d.name) || socialAllowed.has(d.name))
    .map((d) => {
      const cur = Number(ch.skills[d.name] ?? baseOf(d.name)) || 0;
      return {
        name: d.name,
        cur,
        custom: !!d.custom,
        touched: cur > baseOf(d.name),
        // 排序权重：AI 加过的 > 被指定的偏好项 > 非自定义固定项 > 自定义槽位
        // （自定义槽位没填具体名时优先度低，但依然算本职，能吃到职业点）
        rank: (cur > baseOf(d.name) ? 0 : PREFER.has(d.name) ? 5 : 10) + (d.custom ? 5 : 0)
      };
    })
    .sort((a, b) => a.rank - b.rank || b.cur - a.cur);

  occLeft = spreadConcentrated(occCandidates, occLeft);

  // ---- 1b) 职业点还没花完：说明这个职业带「任意特长」，得先选几项 ----
  //
  // 152/225 个职业写着「任意特长可选 N 项」（occupations.js 的 free）。
  // 光靠 fixed 里那几项本职技能，职业点根本花不完——实测贵族剩 152 点、
  // 医生剩 25 点，账目永远平不了，技能页还红着。
  //
  // 原版规则里这 N 项由玩家自选，选中即算本职。这里替 AI 选：
  // 优先挑 AI 已经加过点的技能（说明它本来就想要这项），
  // 再挑跑团常用技能，最后才轮到其余技能。
  if (occLeft > 0) {
    const occ = findOccupation(ch.occupation);
    const freeCount = Number(occ?.free) || 0;

    if (freeCount > 0) {
      const alreadyPicked = new Set(Array.isArray(ch.occFreeSkills) ? ch.occFreeSkills : []);
      const FREE_PREFER = [
        '侦查', '聆听', '图书馆使用', '心理学', '潜行', '急救',
        '话术', '说服', '估价', '乔装', '妙手', '攀爬', '游泳',
        '汽车驾驶', '历史', '神秘学', '计算机使用', '机械维修'
      ];

      // 候选：还没被算作本职、且不是排除项的技能
      const freePool = SKILL_DEFS
        .filter((d) => !EXCLUDED.has(d.name))
        .filter((d) => !isOcc(d.name))
        // 空的自定义槽没有名字，选了也不知道是什么，跳过
        .filter((d) => !d.custom || displayOf(d.name))
        .map((d) => {
          const cur = Number(ch.skills[d.name] ?? baseOf(d.name)) || 0;
          const touched = cur > baseOf(d.name);
          const preferIdx = FREE_PREFER.indexOf(d.name);
          let rank = 3;
          if (touched) rank = 0;                       // AI 已经加过点的
          else if (preferIdx >= 0) rank = 1;           // 常用技能
          return { name: d.name, cur, rank, preferIdx };
        })
        .sort((a, b) => a.rank - b.rank || b.cur - a.cur || a.preferIdx - b.preferIdx);

      // 先按「需要几项」挑出前 N 项，剩下的余额再按需扩
      const picked = freePool.slice(0, Math.max(freeCount, 1)).map((x) => x.name);
      ch.occFreeSkills = [...alreadyPicked, ...picked.filter((n) => !alreadyPicked.has(n))];

      // 选完特长后本职范围变大，重算候选再分一轮
      const moreCandidates = SKILL_DEFS
        .filter((d) => !EXCLUDED.has(d.name) && isOcc(d.name))
        .map((d) => {
          const cur = Number(ch.skills[d.name] ?? baseOf(d.name)) || 0;
          return { name: d.name, cur };
        })
        .sort((a, b) => b.cur - a.cur);

      occLeft = spreadConcentrated(moreCandidates, occLeft);
    }
  }

  // ---- 2) 兴趣点：先抬 AI 已经碰过的非本职技能 ----
  //
  // 排序决定这张卡「像不像一个人」。之前只按 touched / 当前值排，
  // 结果记者的兴趣点全砸到「格斗：斗殴」「射击：手枪」上——
  // 因为战斗技能初始值高（25/20），排在了前面。这显然不对：
  // 记者的兴趣应该是摄影、话术、潜行这类，而不是练拳。
  //
  // 现在的优先级：
  //   0) AI 已经加过点的非本职技能 —— 它认为这角色对这事有兴趣
  //   1) AI 填了具体名字的自定义槽 —— 技艺①=摄影、外语①=拉丁语，
  //      这种「有名字的兴趣」比什么都更能体现人设
  //   2) 调查刚需 —— 潜行/急救/心理学/话术/说服这类跑团天天用
  //   3) 其余普通技能
  //   8) 战斗技能 —— 除非 AI 主动加过（rank 0），否则不该白送
  //   9) 没填名字的空自定义槽 —— 加了也看不出是什么，最靠后
  const CORE_SKILLS = new Set([
    '侦查', '聆听', '图书馆使用', '潜行', '心理学',
    '急救', '闪避', '话术', '说服', '估价', '乔装', '妙手'
  ]);
  // 战斗类：不是不能加，但不该是「没得选时」的默认去处
  const COMBAT_SKILLS = new Set([
    '格斗：斗殴', '射击：手枪', '投掷', '炮术', '爆破'
  ]);

  const intCandidates = SKILL_DEFS
    .filter((d) => !EXCLUDED.has(d.name) && !isOcc(d.name))
    .map((d) => {
      const cur = Number(ch.skills[d.name] ?? baseOf(d.name)) || 0;
      const touched = cur > baseOf(d.name);
      const named = !!d.custom && !!displayOf(d.name);

      let rank = 3;
      if (touched) rank = 0;
      else if (named) rank = 1;
      else if (d.custom) rank = 9;              // 空的自定义槽
      else if (COMBAT_SKILLS.has(d.name)) rank = 8;
      else if (CORE_SKILLS.has(d.name)) rank = 2;

      return { name: d.name, cur, touched, rank };
    })
    // 同组内按当前值从高到低：AI 已经抬高的说明它看重这项
    .sort((a, b) => a.rank - b.rank || b.cur - a.cur);

  intLeft = spreadConcentrated(intCandidates, intLeft);

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

/**
 * 给界面用的「一键随机」：不走 AI，纯本地骰一张能用的卡。
 *
 * 之前的实现有个严重 bug：它按 `EDU*4` 硬编码算点数，然后把点撒到
 * 「侦查/聆听/图书馆使用…」这些写死的技能上，**完全不看职业**。
 * 结果一张没填职业的卡兴趣点能用掉 220 点（预算只有 INT×2 = 90），
 * 账目直接红成一片；就算填了职业，撒点也跟本职技能对不上，
 * 职业点花不出去、兴趣点反而超支。
 *
 * 现在的做法：
 *   1) 没指定职业就随机挑一个表内职业（并填上性别，别留空格子）
 *   2) 先按职业把本职技能抬起来，用职业点
 *   3) 再挑几项符合职业画像的兴趣技能，用兴趣点
 *   4) 最后交给 fillSkillPoints 收尾，保证账目刚好花完、不超支
 *
 * @param {{name?: string, isPlayer?: boolean, occupation?: string, persona?: string}} opts
 * @returns {object} 角色卡
 */
export function randomCharacter({ name, isPlayer = false, occupation = '', persona = '' } = {}) {
  const ch = createCharacter({ name: name || '调查员', isPlayer });
  ch.attrs = rollAttributes();

  // ---- 职业：没指定就随机挑一个，别留空 ----
  // 留空的卡没有职业点，技能账目永远算不平，玩家还得自己补一个职业。
  const occHit = occupation ? findOccupation(occupation) : null;
  ch.occupation = occHit ? occupation : pickRandomOccupation();

  if (persona) ch.persona = persona;

  // ---- 性别：随机，别留空格子 ----
  if (!String(ch.gender || '').trim()) {
    ch.gender = Math.random() < 0.5 ? '男' : '女';
  }

  refreshDerived(ch);

  ch.hp.current = ch.hp.max;
  ch.mp.current = ch.mp.max;
  ch.san.current = ch.san.max;
  ch.san.temp = ch.san.max;
  ch.luck.current = ch.attrs.LUCK;

  // ---- 挑几项「这次随机想突出」的技能 ----
  //
  // 早期版本是先给技能撒一大把点，再让 fillSkillPoints 收拾残局。
  // 那样做的后果是账目经常崩：撒点撒到本职上，职业点就超支；
  // 撒到非本职上，兴趣点又超支。削点逻辑虽然能兜住，但会削出
  // 「医生 380/340」这种先超再削的难看中间态，实测 300 次里有 9 次没削平。
  //
  // 现在不预撒点：只告诉 fillSkillPoints「这次偏好这几项」，
  // 让它一次性把点数分配到位，账目天然是平的。
  const displayOf = (n) => (ch.customNames || {})[n] || '';
  const shuffle = (arr) => arr.slice().sort(() => Math.random() - 0.5);

  const occPool = SKILL_DEFS
    .filter((d) => isOccupationalSkill(ch, d.name, displayOf))
    .filter((d) => d.name !== '闪避' && d.name !== '克苏鲁神话' && d.name !== '信用评级')
    // 空的自定义槽（射击①、格斗①）没填名字，随机时跳过，
    // 免得生成一张「射击①=45」但不知道是什么枪的卡
    .filter((d) => !d.custom || displayOf(d.name))
    .map((d) => d.name);

  const hobbyPool = [
    '侦查', '聆听', '图书馆使用', '潜行', '心理学', '急救', '话术',
    '说服', '估价', '乔装', '妙手', '攀爬', '游泳', '汽车驾驶', '历史', '神秘学'
  ].filter((n) => !isOccupationalSkill(ch, n, displayOf));

  // 每次随机挑一部分，让同职业的两张卡不至于长得一模一样
  const prefer = [
    ...shuffle(occPool).slice(0, Math.max(2, Math.ceil(occPool.length * 0.6))),
    ...shuffle(hobbyPool).slice(0, 3)
  ];

  // ---- 收尾：把账目做平（不超支、不留余额） ----
  //
  // 闪避排除在外：这张卡的产品约定是「闪避 = DEX/2」，
  // 补点逻辑要是把它抬起来，随机卡就与约定不符了。
  fillSkillPoints(ch, { exclude: ['闪避'], prefer });

  return normalizeCharacter(ch);
}

/** 随机挑一个职业表里的职业名 */
function pickRandomOccupation() {
  return OCCUPATIONS[Math.floor(Math.random() * OCCUPATIONS.length)]?.name || '记者';
}
