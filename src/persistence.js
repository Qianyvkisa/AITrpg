// ---------------------------------------------------------------------------
// 存档快照：状态 ↔ 存档 JSON 的双向转换
// 只依赖 state 对象，不碰 DOM
// ---------------------------------------------------------------------------

/**
 * 算「推进了几轮」。
 * 玩家模式以玩家消息条数为准；旁观模式没有玩家消息，用显式轮数。
 * 两个来源都取最大值，避免旧存档或新字段缺失时算出 0。
 */
function turnCount(state) {
  const fromMessages = (state.messages || []).filter((m) => m.role === 'user').length;
  const explicit = state.turns || 0;
  return Math.max(fromMessages, explicit);
}

/** 打包一份可写入磁盘的存档 */
export function buildSnapshot(state) {
  return {
    meta: {
      title: state.module?.title || '自由创作',
      scene: state.scenario.scene,
      charName: state.playerChar?.name || '',
      turns: turnCount(state),
      mode: state.mode || 'player',
      savedAt: Date.now()
    },
    state: {
      playerChar: state.playerChar,
      teammates: state.teammates,
      companions: state.companions || [],
      messages: state.messages,
      scenario: state.scenario,
      module: state.module,
      mode: state.mode || 'player',
      turns: turnCount(state),
      tone: state.tone,
      autoTeammate: state.autoTeammate,
      teammateChance: state.teammateChance
    }
  };
}

/** 把存档内容写回 state（兼容老存档的裸 state 格式） */
export function applySnapshot(state, snapshot) {
  const s = snapshot.state || snapshot;

  state.playerChar = s.playerChar || null;
  state.teammates = s.teammates || [];
  // 老存档没有伙伴这一层，给空数组兜底
  state.companions = Array.isArray(s.companions) ? s.companions : [];
  state.messages = s.messages || [];
  state.scenario = s.scenario || state.scenario;
  state.module = s.module || null;
  state.mode = s.mode || 'player';
  state.turns = s.turns ?? (state.messages || []).filter((m) => m.role === 'user').length;
  state.tone = s.tone || '经典恐怖';
  // 旧存档没有这两个字段，用默认值兜底（保持开启，别让老存档突然变哑巴）
  state.autoTeammate = s.autoTeammate !== false;
  state.teammateChance = Number.isFinite(s.teammateChance) ? s.teammateChance : 0.7;

  return state;
}
