// ---------------------------------------------------------------------------
// 主界面菜单按钮的显示规则（纯函数，不碰 DOM，方便单测）
//
// 规则：
//   有进度  → 「继续」+「放弃游戏」，隐藏「开始」
//   无进度  → 只显示「开始」，隐藏「继续」与「放弃游戏」
// 即「开始」与「继续」永远互斥，绝不同时出现。
// ---------------------------------------------------------------------------

/**
 * 判断存档里是否有真实进度。
 * 玩家模式：玩家至少行动过一次（只有开场白不算）。
 * 旁观模式：没有玩家消息，改看已推进的轮数。
 */
export function hasRunTurn(snapshot) {
  const s = snapshot?.state || snapshot;
  if (!s) return false;

  const users = (s?.messages || []).filter((m) => m.role === 'user').length;
  if (users > 0) return true;

  // 旁观模式靠显式轮数判断
  if ((s?.mode || 'player') === 'spectator') {
    return (s?.turns ?? 0) > 0 || (s?.messages || []).length > 1;
  }
  return false;
}

/**
 * 算出三个按钮的可见性。
 * @param {boolean} hasProgress 是否存在可继续的进度
 * @returns {{start: boolean, cont: boolean, abandon: boolean}}
 */
export function menuButtonVisibility(hasProgress) {
  return {
    start: !hasProgress,
    cont: hasProgress,
    abandon: hasProgress
  };
}
