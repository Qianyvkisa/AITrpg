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

/**
 * 连续自动推进的轮数上限：防止模型陷入「无事发生→继续」的死循环烧 token。
 *
 * 注意这是**连续**自动推进的轮数，不是整局游戏轮数。玩家任何一次手动操作
 * （点推进、发消息、重开自动推进）都会把计数清零，所以正常跑团永远碰不到它。
 *
 * 原来这个上限作用在 state.turns（整局轮数）上，后果是：
 *   - 一局玩到 200 轮就再也开不了自动推进，而且是**永久**的——因为
 *     max-turns 被当成终局，toggle 里直接拒绝开启，玩家没有任何恢复手段
 *   - 2 秒间隔下 200 轮只要 7 分钟就耗尽，正常玩一局必然撞上
 * 现在改成连续计数 + 可恢复，它才真正只拦「失控空转」这一种情况。
 */
export const AUTO_ADVANCE_MAX_TURNS = 1000;

/** 推进间隔的允许范围（毫秒）：太快像刷屏，太慢玩家以为卡死 */
export const MIN_DELAY = 500;
export const MAX_DELAY = 60000;

/**
 * 默认推进间隔（毫秒）。
 *
 * 取 2 秒：一轮 KP 叙述通常要读好几行，2 秒刚好够扫完最后一段、
 * 又不至于让人盯着屏幕等。这个值同时是 clampDelay 的兜底值，
 * 也是 state.js 里 autoAdvanceDelay 的初值，两处必须一致。
 */
export const DEFAULT_DELAY = 2000;

/**
 * 可恢复故障的自动重试上限。
 *
 * 502/503/504、网络抖动这类是**暂时性**故障，等几秒通常就好，让玩家手动点
 * 「推进」毫无道理——自动推进的意义就是不用管。但也不能无限重试：上游真的
 * 挂了的时候，无限重试只会一直烧请求、一直刷提示。
 *
 * 取 3 次：配合下面的退避（5s→10s→20s），总共等约 35 秒。网关抖动一般
 * 几秒就恢复，真挂了的服务 35 秒也够判断出来了。
 */
export const AUTO_RECOVER_MAX = 3;

/**
 * 第 n 次自动重试前要等多久（毫秒）。
 *
 * 退避而不是固定间隔：上游已经 502 了，紧接着原速猛打只会雪上加霜。
 * 5s → 10s → 20s，封顶 30s。
 *
 * @param {number} failureCount 连续失败次数（从 1 开始）
 * @param {object} [opts] { base, cap }
 */
export function recoveryDelay(failureCount, opts = {}) {
  const base = Number.isFinite(opts.base) ? opts.base : 5000;
  const cap = Number.isFinite(opts.cap) ? opts.cap : 30000;
  const n = Math.max(1, Math.floor(Number(failureCount) || 1));
  return Math.min(cap, base * Math.pow(2, n - 1));
}

/**
 * 判断此刻能否自动推进。
 *
 * @param {object} p
 * @param {string} p.mode           'player' | 'spectator'
 * @param {boolean} p.autoAdvance   开关是否打开
 * @param {boolean} p.busy          是否有请求在跑
 * @param {boolean} p.ended         剧情是否已结束
 * @param {boolean} p.pendingRoll   是否有等待玩家掷的骰
 * @param {number}  p.turns         已**连续**自动推进的轮数（不是整局轮数）
 * @param {number} [p.maxTurns]     轮数上限
 * @returns {null|string} null=可以推进；否则返回阻止原因
 *
 * 原因取值：
 *   'not-spectator'  不是旁观模式（玩家模式没有推进的输入源）
 *   'off'            开关没打开
 *   'busy'           上一次请求还没跑完
 *   'ended'          剧情已结束
 *   'pending-roll'   有检定没掷（推进会让 KP 编造结果）
 *   'max-turns'      连续自动推进达到上限（可恢复：手动推进一次即清零）
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
 * 终局（ended）：剧情真的结束了，只能开新局。
 *
 * 暂时（busy / pending-roll / max-turns）：条件解除后能继续，**不能关开关**——
 *   关掉的话玩家掷完骰就得再手动点一次「自动推进」，很别扭。
 *
 * max-turns 归到这一类是有教训的：它原来被当成终局，导致一局推进到上限后
 * 玩家**永久**开不了自动推进（toggle 直接拒绝），只能重开游戏。但它本来只是
 * 一个防失控的保护，玩家手动推一次就该能继续。
 *
 * 中性（off / not-spectator）：界面状态本身就不该推进，不做任何动作。
 */
export function isTerminalBlocker(reason) {
  return reason === 'ended';
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

/**
 * 这次失败是否值得「等一会儿自动重试」。
 *
 * 自动推进遇到故障时不该一律停下等玩家——502 这类过几秒就自己好了，
 * 让人手动点等于把自动推进的意义抵消掉。但也不能什么都重试：
 *
 *   值得重试：502/503/504/429/408、网络断开、超时
 *     → 上游或链路抖了一下，等几秒大概率就通
 *
 *   不值得：401/403/404/400、缺 Key、缺模型名
 *     → 配置错了，等一百年也一样。重试只会让玩家多等，还掩盖真正的问题
 *       （该去设置里改密钥，而不是盯着转圈）
 *
 * 这里按**文案关键词**判断，因为渲染层拿到的是已经翻译好的 friendly 字符串，
 * 拿不到原始 status。关键词与 electron/retry.js 的 describeFailure 保持对应。
 *
 * @param {string} text 错误说明（engine.lastError / res.error）
 * @returns {boolean}
 */
export function isRecoverableFailure(text) {
  const s = String(text || '');
  if (!s) return false;

  // 账户问题优先排除：余额不足 / 积分用完 / 密钥失效。
  //
  // 这类错误常被中转网关包成 HTTP 502 返回，只看状态码会误判成「过会儿就好」，
  // 于是无限重试——但欠费重试一万次也不会好，只会让玩家以为程序坏了。
  // 必须在状态码判断**之前**拦掉。
  if (/余额不足|积分|欠费|insufficient_quota|insufficient_balance/i.test(s)) return false;
  if (/invalid_api_key|account_deactivated/i.test(s)) return false;

  // 配置类错误优先排除：文案里同时出现「HTTP 502」和「API Key」时以配置为准
  // （实际不会同时出现，但排序上先排除更安全）
  if (/API Key|密钥|没有权限|接口地址|模型名不存在|未配置|未填写/i.test(s)) return false;
  if (/HTTP\s+(401|402|403|404|400)\b/i.test(s)) return false;

  if (/HTTP\s+(408|429|500|502|503|504)\b/i.test(s)) return true;
  if (/网关|限流|暂时不可用|暂时没响应|服务不可用|超时/i.test(s)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network|fetch failed|连不上/i.test(s)) return true;

  // 未知错误不自动重试：宁可停下让玩家看到，也别无声地反复重试
  return false;
}

/** 把间隔夹到合理区间，非法值回落到默认值 */
export function clampDelay(ms, fallback = DEFAULT_DELAY) {
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
    // 用「连续自动推进轮数」而不是整局 turns。
    // 整局轮数当上限会误伤：玩到 200 轮就再也开不了自动推进。
    turns: Number(state?.autoAdvanceRun) || 0
  };
}
