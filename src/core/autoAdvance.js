// ---------------------------------------------------------------------------
// 旁观模式「自动推进」的纯逻辑
//
// 为什么单独抽一个模块：判断「现在能不能推进」的规则很容易写错，而且错了
// 就是两种坏结果——要么在骰子还没掷的时候推进（KP 编造结果，故事线和真实
// 骰点错位），要么剧情都结束了还在烧 token。这里只放不碰 DOM、不碰定时器
// 的纯函数，好让测试直接覆盖所有边界。
//
// 界面层（app.js）负责：定时器、按钮外观、提示消息。
// ---------------------------------------------------------------------------

/** 自动推进的连续轮数上限：防止模型陷入「无事发生→继续」的死循环烧 token */
export const AUTO_ADVANCE_MAX_TURNS = 200;

/** 推进间隔的允许范围（毫秒）：太快像刷屏，太慢玩家以为卡死 */
export const MIN_DELAY = 500;
export const MAX_DELAY = 60000;

/**
 * 判断此刻能否自动推进。
 *
 * @param {object} p
 * @param {string} p.mode           'player' | 'spectator'
 * @param {boolean} p.autoAdvance   开关是否打开
 * @param {boolean} p.busy          是否有请求在跑
 * @param {boolean} p.ended         剧情是否已结束
 * @param {boolean} p.pendingRoll   是否有等待玩家掷的骰
 * @param {number}  p.turns         已推进轮数
 * @param {number} [p.maxTurns]     轮数上限
 * @returns {null|string} null=可以推进；否则返回阻止原因
 *
 * 原因取值：
 *   'not-spectator'  不是旁观模式（玩家模式没有推进的输入源）
 *   'off'            开关没打开
 *   'busy'           上一次请求还没跑完
 *   'ended'          剧情已结束
 *   'pending-roll'   有检定没掷（推进会让 KP 编造结果）
 *   'max-turns'      达到轮数上限
 */
export function autoAdvanceBlocker(p) {
  if (p.mode !== 'spectator') return 'not-spectator';
  if (!p.autoAdvance) return 'off';
  if (p.busy) return 'busy';
  if (p.ended) return 'ended';
  if (p.pendingRoll) return 'pending-roll';
  const max = Number.isFinite(p.maxTurns) ? p.maxTurns : AUTO_ADVANCE_MAX_TURNS;
  if ((Number(p.turns) || 0) >= max) return 'max-turns';
  return null;
}

/**
 * 这个阻止原因是「终局」还是「暂时」。
 *
 * 终局（ended / max-turns）：真的不能再推进了，界面要把开关关掉。
 * 暂时（busy / pending-roll）：等条件解除后能自动接上，**不能关开关**——
 *   关掉的话玩家掷完骰就得再手动点一次「自动推进」，很别扭。
 * 中性（off / not-spectator）：界面状态本身就不该推进，不做任何动作。
 */
export function isTerminalBlocker(reason) {
  return reason === 'ended' || reason === 'max-turns';
}

/**
 * 这个阻止原因是否值得打断玩家（弹一句提示）。
 *
 * 'off' / 'busy' / 'not-spectator' 都是正常状态，不该弹任何提示：
 *   - 'off' 是玩家自己关的
 *   - 'busy' 是请求进行中，等它跑完自然就继续了
 *   - 'not-spectator' 是模式不对，界面本来就没这个按钮
 * 其余（ended / pending-roll / max-turns）是「想推进但推不了」，要说一声，
 * 否则玩家会以为功能坏了。
 */
export function shouldReportBlocker(reason) {
  return reason === 'ended' || reason === 'pending-roll' || reason === 'max-turns';
}

/** 把原因翻译成给玩家看的一句话 */
export function blockerMessage(reason, turns) {
  switch (reason) {
    case 'ended':
      return '剧情已结束';
    case 'pending-roll':
      return '有检定还没掷骰';
    case 'max-turns':
      return `已达到自动推进上限（${turns ?? AUTO_ADVANCE_MAX_TURNS} 轮）`;
    default:
      return '';
  }
}

/** 把间隔夹到合理区间，非法值回落到默认值 */
export function clampDelay(ms, fallback = 2500) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(n)));
}

/**
 * 从当前状态快照里提取判断所需的字段。
 * 单独抽出来是为了让 app.js 的调用点短一点，也方便测试直接喂 state。
 */
export function readAutoAdvanceState(state, { busy = false, pendingRoll = false } = {}) {
  return {
    mode: state?.mode || 'player',
    autoAdvance: !!state?.autoAdvance,
    busy: !!busy,
    ended: !!state?.scenario?.ended,
    pendingRoll: !!pendingRoll,
    turns: Number(state?.turns) || 0
  };
}
