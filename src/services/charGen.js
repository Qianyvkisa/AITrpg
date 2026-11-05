// ---------------------------------------------------------------------------
// 角色卡生成：让 AI 按 COC 7e 规则造一张完整的调查员卡
//
// 输出结构与 character.js 的字段对齐，解析后直接交给 normalizeCharacter 兜底。
// ---------------------------------------------------------------------------
import {
  ATTRS, SKILL_DEFS, createCharacter, refreshDerived, rollAttributes,
  baseSkillValue, normalizeCharacter
} from '../core/character.js';

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
2. 技能值 = 初始值 + 职业点 + 兴趣点，单技能一般不超过 90（克苏鲁神话除外，且它必须从 0 开始）。
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
  // 闪避/母语由属性决定，别被 AI 覆盖坏
  ch.skills['闪避'] = Math.floor(ch.attrs.DEX / 2);
  ch.skills['母语'] = ch.attrs.EDU;
  // 克苏鲁神话必须是 0（新建卡不该有神话知识）
  ch.skills['克苏鲁神话'] = Math.min(ch.skills['克苏鲁神话'] || 0, 5);

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
