// ---------------------------------------------------------------------------
// 角色卡 —— COC 7 版
//
// 字段结构对齐《COC7空白卡23（粉）-坪改.xlsx》：
//   调查员信息 / 属性 / 技能表（左 34 项 + 右 33 项）/ 状态 / 武器表 /
//   资产 / 背景故事 / 随身物品 / 调查员经历 / 法术一览
// ---------------------------------------------------------------------------

export const ATTRS = [
  { key: 'STR', name: '力量', en: 'STR' },
  { key: 'CON', name: '体质', en: 'CON' },
  { key: 'SIZ', name: '体型', en: 'SIZ' },
  { key: 'DEX', name: '敏捷', en: 'DEX' },
  { key: 'APP', name: '外貌', en: 'APP' },
  { key: 'INT', name: '智力', en: 'INT' },
  { key: 'POW', name: '意志', en: 'POW' },
  { key: 'EDU', name: '教育', en: 'EDU' },
  { key: 'LUCK', name: '幸运', en: 'LUCK' }
];

/**
 * 技能全表，顺序与 Excel 人物卡一致（左列自上而下，再右列）。
 * value 为 7e 初始值。
 *
 * 带 ①②③ 的是可自定义子类（如「技艺①」可填「摄影」），
 * 基础值取 Excel 里的默认：技艺 5、格斗 25（斗殴）、射击 20（手枪）、
 * 外语 1、科学 1、驾驶 1、生存 10、学识 1。
 */
export const SKILL_DEFS = [
  // ---- 左列 ----
  { name: '会计', base: 5 },
  { name: '人类学', base: 1 },
  { name: '估价', base: 5 },
  { name: '考古学', base: 1 },
  { name: '技艺①', base: 5, custom: true },
  { name: '技艺②', base: 5, custom: true },
  { name: '技艺③', base: 5, custom: true },
  { name: '取悦', base: 15 },
  { name: '攀爬', base: 20 },
  { name: '计算机使用', base: 5 },
  { name: '信用评级', base: 0 },
  { name: '克苏鲁神话', base: 0, mythos: true },
  { name: '乔装', base: 5 },
  { name: '闪避', base: 0, fromDex: true },      // INT(DEX/2)
  { name: '汽车驾驶', base: 20 },
  { name: '电气维修', base: 10 },
  { name: '电子学', base: 1 },
  { name: '话术', base: 5 },
  { name: '格斗：斗殴', base: 25 },
  { name: '格斗①', base: 25, custom: true },
  { name: '格斗②', base: 25, custom: true },
  { name: '格斗③', base: 25, custom: true },
  { name: '射击：手枪', base: 20 },
  { name: '射击①', base: 20, custom: true },
  { name: '射击②', base: 20, custom: true },
  { name: '射击③', base: 20, custom: true },
  { name: '急救', base: 30 },
  { name: '历史', base: 5 },
  { name: '恐吓', base: 15 },
  { name: '跳跃', base: 20 },
  { name: '外语①', base: 1, custom: true },
  { name: '外语②', base: 1, custom: true },
  { name: '外语③', base: 1, custom: true },
  { name: '母语', base: 0, fromEdu: true },       // = EDU

  // ---- 右列 ----
  { name: '法律', base: 5 },
  { name: '图书馆使用', base: 20 },
  { name: '聆听', base: 20 },
  { name: '锁匠', base: 1 },
  { name: '机械维修', base: 10 },
  { name: '医学', base: 1 },
  { name: '博物学', base: 10 },
  { name: '导航', base: 10 },
  { name: '神秘学', base: 5 },
  { name: '操作重型机械', base: 1 },
  { name: '说服', base: 10 },
  { name: '驾驶①', base: 1, custom: true },
  { name: '精神分析', base: 1 },
  { name: '心理学', base: 10 },
  { name: '骑术', base: 5 },
  { name: '科学①', base: 1, custom: true },
  { name: '科学②', base: 1, custom: true },
  { name: '科学③', base: 1, custom: true },
  { name: '妙手', base: 10 },
  { name: '侦查', base: 25 },
  { name: '潜行', base: 20 },
  { name: '生存①', base: 10, custom: true },
  { name: '游泳', base: 20 },
  { name: '投掷', base: 20 },
  { name: '追踪', base: 10 },
  { name: '动物驯养', base: 5 },
  { name: '潜水', base: 1 },
  { name: '爆破', base: 1 },
  { name: '读唇', base: 1 },
  { name: '催眠', base: 1 },
  { name: '炮术', base: 1 },
  { name: '学识①', base: 1, custom: true },
  { name: '自定义技能', base: 0, custom: true }
];

/** 兼容旧代码：技能名 → 基础值 的映射 */
export const DEFAULT_SKILLS = Object.fromEntries(
  SKILL_DEFS.filter((s) => !s.custom).map((s) => [s.name, s.base])
);

/** AI 只关心这些常用技能 */
export const KEY_SKILLS = [
  '侦查', '聆听', '图书馆使用', '心理学', '话术', '说服', '取悦', '潜行',
  '闪避', '格斗：斗殴', '射击：手枪', '急救', '医学', '神秘学', '克苏鲁神话'
];

/**
 * 这个技能能不能在创建角色时手动加点。
 *
 * 克苏鲁神话按原版规则不给加：它衡量的是「见过多少不该见的东西」，
 * 只能靠游戏里的遭遇涨，车卡阶段一律从 0 开始，也不占职业点/兴趣点。
 *
 * @param {string} skillName 技能名
 * @returns {boolean} true 表示可加点
 */
export function isSkillEditable(skillName) {
  const def = SKILL_DEFS.find((d) => d.name === skillName);
  if (!def) return true;
  return !def.mythos;
}

/** 由属性推导的派生值 */
export function derive(attrs) {
  const STR = attrs.STR ?? 50;
  const CON = attrs.CON ?? 50;
  const SIZ = attrs.SIZ ?? 50;
  const DEX = attrs.DEX ?? 50;
  const POW = attrs.POW ?? 50;

  // HP = (CON + SIZ) / 10
  const HP = Math.floor((CON + SIZ) / 10);
  // MP = POW / 5
  const MP = Math.floor(POW / 5);
  // SAN = POW
  const SAN = POW;
  // 体格/伤害加值（7e）
  const strSiz = STR + SIZ;
  let build, db;
  if (strSiz <= 64) { build = -2; db = '-2'; }
  else if (strSiz <= 84) { build = -1; db = '-1'; }
  else if (strSiz <= 124) { build = 0; db = '0'; }
  else if (strSiz <= 164) { build = 1; db = '1d4'; }
  else if (strSiz <= 204) { build = 2; db = '1d6'; }
  else { build = Math.floor((strSiz - 205) / 40) + 3; db = `${build}d6`; }

  // MOV：按 STR/DEX/SIZ 组合
  let MOV;
  if (DEX < SIZ && STR < SIZ) MOV = 7;
  else if (STR >= SIZ && DEX >= SIZ) MOV = 9;
  else MOV = 8;
  if (build >= 2) MOV += 1;

  return { HP, MP, SAN, build, db, MOV };
}

/** 按技能定义算出「初始值」（含 DEX/EDU 推导） */
export function baseSkillValue(def, attrs) {
  if (def.fromDex) return Math.floor((attrs.DEX ?? 50) / 2);
  if (def.fromEdu) return attrs.EDU ?? 50;
  return def.base;
}

/** 创建空白角色卡 */
export function createCharacter({ name = '调查员', isPlayer = false } = {}) {
  const attrs = {};
  for (const a of ATTRS) attrs[a.key] = 50;
  const d = derive(attrs);

  const skills = {};
  for (const def of SKILL_DEFS) skills[def.name] = baseSkillValue(def, attrs);

  return {
    id: 'pc-' + Math.random().toString(36).slice(2, 9),
    name,
    isPlayer,
    age: 30,
    gender: '',
    residence: '',
    hometown: '',
    era: '1920s',
    player: '',            // 玩家名
    occupation: '',
    occupationNo: 0,       // 职业序号（对应 Excel 的 M5）
    attrs,
    skills,
    /** 自定义子技能名：{ '技艺①': '摄影', '外语①': '拉丁语' } */
    customNames: {},
    derived: d,
    // 状态
    hp: { current: d.HP, max: d.HP },
    mp: { current: d.MP, max: d.MP },
    san: { current: d.SAN, max: d.SAN, temp: d.SAN },
    luck: { current: attrs.LUCK },
    status: [],           // 状态标签：重伤、昏迷、疯狂等
    weapons: [],          // { name, type, skill, damage, range, ... }
    inventory: [],
    assets: {
      creditRating: 0,    // 信用评级
      livingStandard: '', // 生活水平
      consumption: '',    // 消费水平
      otherAssets: '',    // 其他资产
      cash: 0,            // 当前现金
      currency: '美元',
      vehicles: '',
      house: '',
      luxury: '',
      stocks: '',
      others: ''
    },
    background: {
      description: '',            // 形象描述
      ideology: '',               // 思想与信念
      significantPeople: '',      // 重要之人
      meaningfulLocations: '',    // 意义非凡之地
      treasuredPossessions: '',   // 宝贵之物
      traits: '',                 // 特质
      wounds: '',                 // 伤口和疤痕
      phobias: '',                // 恐惧症和躁狂症
      story: '',                  // 背景故事
      notes: ''
    },
    experiences: [],      // { module, change } 调查员经历
    mythosLog: [],        // { name, result, note } 神话相关
    spells: [],           // { name, cost, effect } 法术一览
    // 给 AI 的性格设定
    persona: ''
  };
}

/** 用属性重算派生值（改属性后调用） */
export function refreshDerived(ch) {
  ch.derived = derive(ch.attrs);

  // 技能里依赖属性的项跟着走
  for (const def of SKILL_DEFS) {
    if (def.fromDex || def.fromEdu) {
      const cur = ch.skills[def.name];
      // 只在下限被属性决定时同步（玩家加过的点不抹掉）
      if (cur === undefined || cur <= def.base || cur === 0) {
        ch.skills[def.name] = baseSkillValue(def, ch.attrs);
      }
    }
  }
  // 闪避/母语在 Excel 里恒等于 DEX/2、EDU，这里直接对齐
  ch.skills['闪避'] = Math.floor(ch.attrs.DEX / 2);
  ch.skills['母语'] = ch.attrs.EDU;

  // HP/MP/SAN 上限同步，当前值不超上限
  ch.hp.max = ch.derived.HP;
  ch.hp.current = Math.min(ch.hp.current, ch.hp.max);
  ch.mp.max = ch.derived.MP;
  ch.mp.current = Math.min(ch.mp.current, ch.mp.max);
  ch.san.max = ch.derived.SAN;
  ch.san.temp = Math.min(ch.san.temp ?? ch.san.max, ch.san.max);
  ch.san.current = Math.min(ch.san.current, ch.san.temp);
  ch.luck.current = Math.min(ch.luck.current ?? 50, ch.attrs.LUCK);
  return ch;
}

/** 随机生成属性（7e：3d6×5，SIZ/INT/EDU 用 2d6+6×5） */
export function rollAttributes() {
  const d6 = () => Math.floor(Math.random() * 6) + 1;
  const r3 = () => (d6() + d6() + d6()) * 5;
  const r2 = () => (d6() + d6() + 6) * 5;
  return {
    STR: r3(), CON: r3(), SIZ: r2(), DEX: r3(),
    APP: r3(), INT: r2(), POW: r3(), EDU: r2(), LUCK: r3()
  };
}

/**
 * 职业加点（简化版：教育×N 点）。
 *
 * 注意：这是早期只按 EDU 估算的粗略算法，不能反映真实规则——
 * 很多职业是「教育×2＋力量或敏捷×2」这类复合公式，还牵扯本职技能范围。
 * 真正的点数计算见 core/occupations.js 的 occupationTotal() / skillPointBudget()。
 * 保留此函数只是为了兼容既有调用与测试。
 */
export function occupationPoints(attrs, multiplier = 4) {
  return attrs.EDU * multiplier;
}

/** 技能成功率的三档：普通 / 困难 / 极难 */
export function skillLevels(value) {
  return { normal: value, hard: Math.floor(value / 2), extreme: Math.floor(value / 5) };
}

/** 角色卡 → 给 AI 看的紧凑文本 */
export function characterToPrompt(ch, { full = false } = {}) {
  const a = ch.attrs;
  const attrLine = ATTRS.map((x) => `${x.name}${a[x.key]}`).join(' ');

  const skillLine = KEY_SKILLS
    .filter((s) => ch.skills[s] !== undefined)
    .map((s) => `${displaySkillName(ch, s)}${ch.skills[s]}`)
    .join(' ');

  const lines = [
    `【${ch.name}】${ch.isPlayer ? '(玩家角色)' : '(NPC队友)'}${ch.occupation ? ' ' + ch.occupation : ''}`,
    `属性：${attrLine}`,
    `关键技能：${skillLine}`,
    `HP ${ch.hp.current}/${ch.hp.max}  MP ${ch.mp.current}/${ch.mp.max}  SAN ${ch.san.current}/${ch.san.temp}  幸运${ch.luck.current}`,
    `伤害加值 ${ch.derived.db}  体格 ${ch.derived.build}  MOV ${ch.derived.MOV}`
  ];

  if (ch.status.length) lines.push(`状态：${ch.status.join('、')}`);
  if (ch.persona) lines.push(`性格：${ch.persona}`);

  if (full) {
    if (ch.inventory.length) lines.push(`携带：${ch.inventory.join('、')}`);
    if (ch.weapons?.length) {
      lines.push(`武器：${ch.weapons.map((w) => `${w.name}(${w.damage || '?'})`).join('、')}`);
    }
    if (ch.assets?.creditRating !== undefined) lines.push(`信用评级 ${ch.assets.creditRating}`);
    const bg = ch.background || {};
    const bgParts = [];
    if (bg.description) bgParts.push(`外貌/描述：${bg.description}`);
    if (bg.traits) bgParts.push(`特质：${bg.traits}`);
    if (bg.phobias) bgParts.push(`恐惧症：${bg.phobias}`);
    if (bg.ideology) bgParts.push(`信念：${bg.ideology}`);
    if (bg.significantPeople) bgParts.push(`重要之人：${bg.significantPeople}`);
    if (bgParts.length) lines.push(bgParts.join('；'));
  }

  return lines.join('\n');
}

/** 技能显示名：自定义子类带出玩家填的名字 */
export function displaySkillName(ch, key) {
  const custom = ch.customNames?.[key];
  if (!custom) return key;
  // 「技艺①」→「技艺：摄影」
  const base = key.replace(/[①②③]/, '');
  return `${base}：${custom}`;
}

/** 深拷贝（存档用） */
export function cloneCharacter(ch) {
  return JSON.parse(JSON.stringify(ch));
}

/**
 * 补齐旧存档里缺的字段。
 * 老版本的角色卡没有 weapons/assets/experiences 等，读档时要能兜住。
 */
export function normalizeCharacter(ch) {
  if (!ch || typeof ch !== 'object') return createCharacter();
  const base = createCharacter({ name: ch.name || '调查员', isPlayer: !!ch.isPlayer });

  const out = { ...base, ...ch };
  out.attrs = { ...base.attrs, ...(ch.attrs || {}) };
  // 技能：以全表为底，保留旧值
  out.skills = { ...base.skills, ...(ch.skills || {}) };
  out.customNames = { ...(ch.customNames || {}) };
  out.hp = { ...base.hp, ...(ch.hp || {}) };
  out.mp = { ...base.mp, ...(ch.mp || {}) };
  out.san = { ...base.san, ...(ch.san || {}) };
  out.luck = { ...base.luck, ...(ch.luck || {}) };
  out.assets = { ...base.assets, ...(ch.assets || {}) };
  out.background = { ...base.background, ...(ch.background || {}) };
  out.status = Array.isArray(ch.status) ? ch.status : [];
  out.weapons = Array.isArray(ch.weapons) ? ch.weapons : [];
  out.inventory = Array.isArray(ch.inventory) ? ch.inventory : [];
  out.experiences = Array.isArray(ch.experiences) ? ch.experiences : [];
  out.mythosLog = Array.isArray(ch.mythosLog) ? ch.mythosLog : [];
  out.spells = Array.isArray(ch.spells) ? ch.spells : [];

  refreshDerived(out);
  return out;
}
