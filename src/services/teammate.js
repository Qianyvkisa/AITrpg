// ---------------------------------------------------------------------------
// 队友 AI：让 AI 扮演队友主动插话
// 从 app.js 抽出来，因为它是独立的一次 LLM 调用，与界面渲染无关
// ---------------------------------------------------------------------------
import { characterToPrompt } from '../core/character.js';
import { teammateSystemPrompt } from '../core/prompts.js';

/**
 * 随机挑一位队友，生成一句符合人设的反应。
 * @returns { ok, name?, text?, error? }
 */
export async function generateTeammateLine(state, api) {
  const teammates = state.teammates || [];
  if (!teammates.length) return { ok: false, error: '还没有队友' };

  const t = teammates[Math.floor(Math.random() * teammates.length)];

  const party = [
    state.playerChar ? characterToPrompt(state.playerChar) : '',
    ...teammates.map((x) => characterToPrompt(x))
  ].filter(Boolean).join('\n');

  const sys = teammateSystemPrompt({
    char: characterToPrompt(t, { full: true }),
    party,
    scene: state.scenario.scene,
    tone: state.tone
  });

  // 最近的现场：旁白、玩家行动、骰点，以及已经说过的队友和 NPC
  // 把 NPC 台词也带上，队友才能回应 NPC 说的话，而不是自说自话
  const recentNarration = state.messages
    .filter((m) => m.role === 'keeper' || m.role === 'user' || m.role === 'roll' || m.role === 'teammate' || m.role === 'npc')
    .slice(-8)
    .map((m) => {
      if (m.role === 'keeper') return `KP：${m.clean ?? m.text}`;
      if (m.role === 'user') return `玩家：${m.text}`;
      if (m.role === 'teammate') return `队友·${m.name}：${m.text}`;
      if (m.role === 'npc') return `NPC·${m.name}：${m.text}`;
      return `[骰点] ${m.text}`;
    })
    .join('\n');

  // 最近说话的队友，用来提示别重复别人说过的话
  const lastSpeaker = [...state.messages]
    .reverse()
    .find((m) => m.role === 'teammate' && m.name !== t.name)?.name;

  const hint = lastSpeaker
    ? `\n注意：${lastSpeaker} 刚说过话，你不要附和式重复，要么补充新信息，要么直接反驳他。`
    : '';

  const res = await api.chat({
    ...state.apiConfig,
    temperature: 0.95,
    maxTokens: 300,
    stream: false,
    purpose: 'teammate',
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `最近的现场情况：\n${recentNarration}\n${hint}\n\n现在轮到你反应。只说 1-2 句这个角色会说的话。`
      }
    ]
  });

  if (!res.ok) return { ok: false, error: res.error };

  const text = (res.text || '').trim().replace(/^[「『"]|[」』"]$/g, '');
  if (!text) return { ok: false, error: '队友没有给出回应' };

  return { ok: true, name: t.name, text };
}
