// ---------------------------------------------------------------------------
// 队友自主行动：让每个队友由**自己的一次 LLM 调用**决定这一轮做什么
//
// 与 teammate.js 的分工（两者不要混用）：
//   teammate.js        → 队友说一句台词，KP 叙述后的点缀，不改变局面
//   teammateAct.js     → 队友决定这一轮的行动，是真正参与推进的主体
//
// 关键设计约束：
//   1. 队友 AI 只能提出「我想做什么 + 请求检定」，**不能宣布结果**。
//      骰点仍由 dice.js 掷，后果仍由 KP 叙述。否则会出现
//      「队友说自己撬开了锁，但其实没掷骰」的规则漏洞。
//   2. 每个队友独立调用一次，队友之间才会真的有不同的判断和分歧。
//      一次调用让所有队友一起决定，等于又变回「一个 AI 分饰多角」。
//   3. 队友 AI 输出的 [[CHECK]] 会被改写成带角色名的形式，
//      再交给现有的 directives 结算链路——复用同一套掷骰逻辑，
//      不另起一套，避免两条路径算出不同结果。
// ---------------------------------------------------------------------------
import { characterToPrompt } from '../core/character.js';
import { teammateActionPrompt } from '../core/prompts.js';
import { parseDirectives } from '../core/protocol.js';

/** 最近现场取多少条消息喂给队友 AI，控制 token */
const RECENT_LIMIT = 8;

/** 队友单次回复的长度上限：只要一个行动，不需要长篇 */
const MAX_TOKENS = 220;

/**
 * 组装队友能看到的「最近现场」。
 *
 * 注意这里**故意不喂 KP 的完整旁白**，只给最近几条的摘要式片段：
 * 队友 AI 需要知道刚发生了什么才能接得上，但给太多会让它开始替 KP 写世界。
 */
function buildRecentContext(state) {
  const rows = state.messages
    .filter((m) =>
      m.role === 'keeper' || m.role === 'user' || m.role === 'teammate' ||
      m.role === 'npc' || m.role === 'roll'
    )
    .slice(-RECENT_LIMIT)
    .map((m) => {
      if (m.role === 'keeper') return `KP：${(m.clean ?? m.text ?? '').slice(0, 300)}`;
      if (m.role === 'user') return `玩家：${m.text ?? ''}`;
      if (m.role === 'teammate') return `队友·${m.name}：${m.text ?? ''}`;
      if (m.role === 'npc') return `NPC·${m.name}：${m.text ?? ''}`;
      return `[骰点] ${m.text ?? ''}`;
    })
    .filter(Boolean);

  return rows.join('\n');
}

/**
 * 把队友 AI 输出的 [[CHECK: 技能 | 原因=...]] 补上角色名。
 *
 * 队友 AI 被要求不写角色名（它只扮演自己，写名字反而容易写错），
 * 但 directives 结算需要知道是谁在检定。这里统一补成 `角色=队友名`，
 * 顺带兼容 AI 自作主张写了名字的情况——以它自己为准，避免串人。
 */
export function stampActorIntoDirectives(text, name) {
  return String(text ?? '').replace(
    /\[\[(CHECK|SAN|DAMAGE|HP|MP):([^\]]*)\]\]/g,
    (full, type, bodyRaw) => {
      const parts = bodyRaw.split('|').map((s) => s.trim());
      const head = parts[0] ?? '';
      const rest = parts.slice(1).filter((s) => s && !/^角色\s*=/.test(s));
      return `[[${type}: ${[head, `角色=${name}`, ...rest].filter(Boolean).join(' | ')}]]`;
    }
  );
}

/**
 * 让一位队友决定这一轮的行动。
 *
 * @param {object} state 全局 state
 * @param {object} api   window.api
 * @param {object} char  这位队友的角色卡
 * @param {object} opts  { playerAction, lastSpeaker }
 * @returns {{ok:boolean, name?:string, text?:string, directives?:Array, raw?:string, error?:string}}
 */
export async function generateTeammateAction(state, api, char, opts = {}) {
  const teammates = state.teammates || [];
  if (!char) return { ok: false, error: '没有指定队友' };

  const party = [
    state.playerChar ? characterToPrompt(state.playerChar) : '',
    ...teammates.map((x) => characterToPrompt(x))
  ].filter(Boolean).join('\n');

  const sys = teammateActionPrompt({
    char: characterToPrompt(char, { full: true }),
    party,
    scene: state.scenario?.scene,
    tone: state.tone,
    recent: buildRecentContext(state),
    playerAction: opts.playerAction,
    lastSpeaker: opts.lastSpeaker
  });

  const res = await api.chat({
    ...state.apiConfig,
    temperature: 0.9,
    maxTokens: MAX_TOKENS,
    stream: false,
    // purpose 仍是 'teammate'：这样它走设置里的「队友模型」，
    // 可以把队友交给本地小模型跑，省 API 费用
    purpose: 'teammate',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: '现在轮到你行动。只写你要做的事，需要检定就加指令。' }
    ]
  });

  if (!res.ok) return { ok: false, error: res.error };

  const raw = (res.text || '').trim();
  if (!raw) return { ok: false, error: '队友没有给出行动' };

  // 解析出指令，但**不在这里结算**——结算交给 engine，
  // 因为它要保证「同一条消息里的指令只结算一次」并串进续跑流程。
  const { directives, clean } = parseDirectives(raw);

  // 行动正文：剥掉指令后的部分。若 AI 只写了指令没写行动，
  // 用一句中性的占位，避免界面出现空气泡。
  const actionText = clean.trim() || `（${char.name} 准备行动）`;

  return {
    ok: true,
    name: char.name,
    text: actionText,
    // 指令已补上角色名，可以直接交给 directives 结算
    directives: directives.map((d) => ({
      ...d,
      opts: { ...d.opts, 角色: char.name }
    })),
    raw
  };
}

/**
 * 决定这一轮有哪些队友行动。
 *
 * 用概率和开关控制成本：每个队友独立调用一次 API，
 * 2 个队友就是每轮多 2 次请求，必须有节制。
 *
 * @returns {Array<object>} 要行动的队友列表
 */
export function pickActingTeammates(state, { chance } = {}) {
  const teammates = state.teammates || [];
  if (!teammates.length) return [];

  // 总开关关掉 → 全部不行动（退回 KP 代演）
  if (state.teammateAutonomous === false) return [];

  // 剧情结束就不再让人行动
  if (state.scenario?.ended) return [];

  const rate = Number.isFinite(chance)
    ? chance
    : (Number.isFinite(state.teammateChance) ? state.teammateChance : 0.7);

  // 逐个独立判定，让「这一轮谁动」有真实的不确定性。
  // 但要保证至少有一位会行动（概率>0 时），否则整轮没人动、
  // 玩家会觉得队友全是木头。
  const acting = teammates.filter(() => Math.random() < rate);
  if (!acting.length && rate > 0) {
    acting.push(teammates[Math.floor(Math.random() * teammates.length)]);
  }
  return acting;
}
