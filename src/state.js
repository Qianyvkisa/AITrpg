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

/**
 * 首次启动时的默认调查员。
 *
 * 故意留成一张**空白卡**：职业、技能、点数全空，等玩家在「游戏设定」里
 * 自己点「AI 生成」或「随机」来车。
 *
 * 为什么不做预填：预填一张卡等于替玩家做了「你玩什么职业」的决定，
 * 而 AI 生成本来就能按玩家给的方向（比如「1920s 的华裔记者，胆小但执着」）
 * 造出更贴合的卡。留空反而让入口更明确——玩家一眼就知道该点哪个按钮。
 *
 * 注意：空白卡不能直接上桌（没有职业 → 职业点算成 0、技能全是初始值）。
 * 设定界面的「AI 生成 / 随机 / 导入」三个入口负责把它填满。
 */
export function createDefaultCharacter() {
  const ch = createCharacter({ name: '调查员', isPlayer: true });
  ch.persona = '谨慎、好奇，遇事喜欢先观察再动手。';
  return ch;
}
