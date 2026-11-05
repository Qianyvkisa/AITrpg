// ---------------------------------------------------------------------------
// 开局配置：把「游戏设定界面」的选择变成一份可用的队伍
// 纯逻辑、不碰 DOM，方便单测
// ---------------------------------------------------------------------------

import { createCharacter, refreshDerived, rollAttributes, normalizeCharacter } from './character.js';
import { createDefaultCharacter } from '../state.js';

/** 设定界面里可选的队友人数 */
export const TEAMMATE_COUNT_OPTIONS = [0, 1, 2, 3, 4];
export const MAX_TEAMMATES = 4;

/** 参与方式 */
export const MODES = [
  {
    key: 'player',
    label: '成为调查员',
    desc: '你扮演一位调查员，亲自行动、亲自掷骰'
  },
  {
    key: 'spectator',
    label: '旁观',
    desc: '你不扮演任何人，只看 AI 把这一局演完'
  }
];

/**
 * 内置队友模板池。
 * 设定界面按人数从池子里取，保证同一局里不会出现重名。
 */
const CHARACTER_POOL = [
  {
    name: '林默',
    occupation: '退伍军医',
    persona: '话少，抽烟，遇到血会下意识先检查伤口。表面冷漠，但会挡在别人前面。',
    skills: ['急救', '医学', '射击：手枪']
  },
  {
    name: '陈叙',
    occupation: '大学讲师',
    persona: '谨慎到近乎胆小，随身带着笔记本。一紧张就开始引经据典。',
    skills: ['图书馆使用', '历史', '神秘学']
  },
  {
    name: '白鹭',
    occupation: '记者',
    persona: '好奇心压过恐惧，永远想再多问一句。擅长套话，也擅长惹麻烦。',
    skills: ['话术', '心理学', '侦查']
  },
  {
    name: '顾长生',
    occupation: '古董商',
    persona: '油滑，见钱眼开，但眼光极毒。真遇到事时意外地靠得住。',
    skills: ['估价', '侦查', '说服']
  },
  {
    name: '周砚',
    occupation: '私家侦探',
    persona: '冷静、寡言，习惯先观察再动手。对谎言有近乎本能的直觉。',
    skills: ['侦查', '心理学', '潜行']
  },
  {
    name: '苏晚',
    occupation: '护士',
    persona: '温柔但固执，见不得有人受伤。害怕时反而会强迫自己冷静下来。',
    skills: ['急救', '医学', '聆听']
  },
  {
    name: '郑野',
    occupation: '码头工人',
    persona: '嗓门大，脾气直，不信鬼神。力气活都归他，脑子活都推给别人。',
    skills: ['格斗：斗殴', '攀爬', '投掷']
  },
  {
    name: '何九',
    occupation: '图书馆员',
    persona: '安静，说话轻，记性好得吓人。知道很多不该知道的书名。',
    skills: ['图书馆使用', '母语', '神秘学']
  }
];

/** 人数收敛到合法范围，非法输入按 0 处理 */
export function clampTeammateCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_TEAMMATES, Math.floor(v)));
}

/**
 * 按序号造一位队友。
 * 用随机起点在模板池里取，保证同一局内不重名。
 * @param {number} index 第几位队友（0 起）
 * @param {() => number} rand 随机源，测试时可注入
 */
export function createTeammate(index = 0, rand = Math.random) {
  const start = Math.floor(rand() * CHARACTER_POOL.length) % CHARACTER_POOL.length;
  const seed = CHARACTER_POOL[(start + index) % CHARACTER_POOL.length];

  const ch = createCharacter({ name: seed.name, isPlayer: false });
  ch.occupation = seed.occupation;
  ch.persona = seed.persona;

  ch.attrs = rollAttributes();
  refreshDerived(ch);

  // refreshDerived 只把上限往下压，这里要让当前值填满
  ch.hp.current = ch.hp.max;
  ch.mp.current = ch.mp.max;
  ch.san.current = ch.san.max;
  ch.san.temp = ch.san.max;
  ch.luck.current = ch.attrs.LUCK;

  for (const sk of seed.skills) {
    ch.skills[sk] = Math.max(ch.skills[sk] ?? 0, 60);
  }

  return ch;
}

/**
 * 组装一局的开局配置。
 *
 * 设定界面若已经车好角色卡（playerChar / teammates），直接用它们；
 * 没给的部分按人数自动生成，保证旧调用方式仍然可用。
 *
 * @param {{mode?: 'player'|'spectator', module?: object|null, teammateCount?: number,
 *          rand?: () => number, playerChar?: object|null, teammates?: object[]}} cfg
 * @returns {{mode, module, teammateCount, teammates, playerChar}}
 */
export function buildSession({
  mode = 'player', module = null, teammateCount = 1, rand = Math.random,
  playerChar = null, teammates: preset = null, companions: presetCompanions = null
} = {}) {
  const count = clampTeammateCount(teammateCount);

  // 优先用设定界面车好的队友卡
  const teammates = [];
  if (Array.isArray(preset) && preset.length) {
    for (const t of preset.slice(0, count)) teammates.push(normalizeCharacter(t));
  }
  // 不够的补齐
  for (let i = teammates.length; i < count; i++) {
    teammates.push(createTeammate(i, rand));
  }

  // 调查员伙伴：不在队伍里，只是「随时可能赶来的援军」。
  // 不占队友名额，所以这里不做数量截断，由设定界面自己控制。
  const companions = Array.isArray(presetCompanions)
    ? presetCompanions.map((c) => normalizeCharacter(c))
    : [];

  const spectator = mode === 'spectator';

  return {
    mode: spectator ? 'spectator' : 'player',
    module: module || null,
    teammateCount: count,
    teammates,
    companions,
    // 旁观模式没有玩家角色；玩家模式优先用车好的卡
    playerChar: spectator
      ? null
      : (playerChar ? normalizeCharacter(playerChar) : createDefaultCharacter())
  };
}
