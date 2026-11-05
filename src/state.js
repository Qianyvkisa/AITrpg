// ---------------------------------------------------------------------------
// 全局游戏状态：唯一的状态容器
// ---------------------------------------------------------------------------
import { createCharacter } from './core/character.js';

/** 建一份全新的游戏状态（首次启动 / 新开团用） */
export function createInitialState() {
  return {
    playerChar: null,
    teammates: [],
    // 调查员伙伴：不在队伍里，剧情需要时由 KP 判断能否赶来支援
    companions: [],
    messages: [],
    scenario: {
      scene: '',
      events: [],
      clues: [],
      secrets: [],
      notes: '',
      ended: false,
      ending: ''
    },
    module: null,
    // 参与方式：'player' 扮演调查员 / 'spectator' 旁观
    mode: 'player',
    // 已推进的轮数（旁观模式下没有玩家消息，靠它判断「有没有进度」）
    turns: 0,
    tone: '经典恐怖',
    // KP 说完后是否让队友 AI 自发接话，以及接话概率
    autoTeammate: true,
    teammateChance: 0.7,
    // apiConfig 由主进程 config:get 填充；这里只放渲染层需要的字段
    apiConfig: {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.8,
      maxTokens: 2048
    },
    saveSlot: 'auto'
  };
}

/** 首次启动时的默认调查员 */
export function createDefaultCharacter() {
  const ch = createCharacter({ name: '调查员', isPlayer: true });
  ch.persona = '谨慎、好奇，遇事喜欢先观察再动手。';
  return ch;
}
