'use strict';

// ---------------------------------------------------------------------------
// 请求重试策略（纯逻辑，不依赖 electron，可被单元测试直接加载）
//
// 为什么需要它：
//
// 真实反馈：跑团跑到一半突然弹出
//   【KP 连接失败】HTTP 502 Bad Gateway ... 模型 xxx 及降级目标全部失败
// 而 502 是**上游网关的瞬时故障**，不是配置错了。原来一次抖动就直接判定失败，
// 自动推进还会因此永久停止，玩家得手动重新开启——体验上像是「程序坏了」。
//
// 所以按错误性质分类：
//   - 瞬时（502/503/504/429、网络断开、超时）→ 值得重试
//   - 永久（401/403/404、模型名错、缺 Key）→ 重试只是浪费时间，直接失败
//
// 这里只放判断逻辑与退避计算，实际的 setTimeout 等待留在调用方，
// 这样测试可以注入假定时器，不必真的等好几秒。
// ---------------------------------------------------------------------------

/** 默认重试次数（不含首次请求）：一共最多请求 3 次 */
const DEFAULT_MAX_RETRIES = 2;

/** 首次重试等待毫秒数 */
const DEFAULT_BASE_DELAY = 800;

/** 退避上限：别让玩家等太久 */
const MAX_BACKOFF = 8000;

/**
 * 可重试的 HTTP 状态码。
 *
 * 502/503/504 是网关/上游不可用，429 是限流，都属于「过一会儿再试可能就好了」。
 * 408 是请求超时。
 *
 * 刻意**不含** 401/403（密钥问题）、404（地址或模型名错）、400（请求格式错）：
 * 这些重试一百次也是同样结果，只会让玩家多等三倍时间才看到真正的错误。
 */
const RETRYABLE_STATUS = new Set([408, 408, 429, 500, 502, 503, 504]);

/**
 * 从错误信息里判断是不是「值得重试」的失败。
 *
 * @param {object} res  chat() 的失败返回值 { ok:false, error, status? }
 * @returns {boolean}
 */
function isRetryable(res) {
  if (!res || res.ok) return false;

  // 玩家主动取消：绝不能重试，否则取消不掉
  if (res.canceled) return false;

  // 有明确状态码时以状态码为准
  if (Number.isFinite(res.status)) {
    return RETRYABLE_STATUS.has(res.status);
  }

  const err = String(res.error || '');

  // 从 "HTTP 502 Bad Gateway" 里把状态码抠出来
  const m = err.match(/HTTP\s+(\d{3})/i);
  if (m) {
    return RETRYABLE_STATUS.has(Number(m[1]));
  }

  // 网络层错误：连接被重置 / DNS 抖动 / 超时
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network|fetch failed|请求超时/i.test(err)) {
    return true;
  }

  // 上游自己报的「全部失败 / 稍后再试」类信息
  if (/all_failed|upstream_error|bad gateway|service unavailable|gateway time-?out|too many requests|rate limit/i.test(err)) {
    return true;
  }

  return false;
}

/**
 * 算第 n 次重试要等多久（指数退避 + 抖动）。
 *
 * 抖动很重要：自动推进可能同时在跑多个请求（KP + 队友），
 * 固定间隔会让它们整齐地一起重试，把已经过载的上游再压一遍。
 *
 * @param {number} attempt 第几次重试（从 1 开始）
 * @param {object} [opts]  { baseDelay, maxBackoff, jitter, random }
 * @returns {number} 毫秒
 */
function backoffDelay(attempt, opts = {}) {
  const base = Number.isFinite(opts.baseDelay) ? opts.baseDelay : DEFAULT_BASE_DELAY;
  const cap = Number.isFinite(opts.maxBackoff) ? opts.maxBackoff : MAX_BACKOFF;
  const jitter = opts.jitter !== false;
  const rnd = typeof opts.random === 'function' ? opts.random : Math.random;

  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = base * Math.pow(2, n - 1);
  const capped = Math.min(cap, raw);

  if (!jitter) return Math.round(capped);
  // ±25% 抖动，避免多请求同步重试
  const factor = 0.75 + rnd() * 0.5;
  return Math.round(Math.min(cap, capped * factor));
}

/**
 * 把失败结果翻译成给玩家看的说明，并指出下一步该怎么办。
 *
 * 原来的错误是直接贴一整段上游 HTML，玩家根本看不懂发生了什么。
 * 这里按错误类型给出可操作的提示。
 *
 * @param {object} res { error, status? }
 * @param {number} [retried] 已经重试过几次
 * @returns {string}
 */
function describeFailure(res, retried = 0) {
  const err = String(res?.error || '未知错误');
  const suffix = retried > 0 ? `（已自动重试 ${retried} 次）` : '';

  const m = err.match(/HTTP\s+(\d{3})/i);
  const status = Number.isFinite(res?.status) ? res.status : (m ? Number(m[1]) : 0);

  if (status === 502 || status === 503 || status === 504) {
    return `模型服务暂时不可用（HTTP ${status}），上游网关故障，通常过一会儿会自己恢复${suffix}。`;
  }
  if (status === 429) {
    return `请求太频繁被限流了（HTTP 429）${suffix}，等几十秒再继续，或在设置里换一个模型。`;
  }
  if (status === 401 || status === 403) {
    return `API Key 无效或没有权限（HTTP ${status}），请到设置里检查密钥。`;
  }
  if (status === 404) {
    return `接口地址或模型名不存在（HTTP 404），请到设置里检查 API 地址与模型名。`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err)) {
    return `连不上 API 服务器${suffix}，检查网络或 API 地址是否正确。`;
  }
  if (/timeout|超时|ETIMEDOUT/i.test(err)) {
    return `请求超时${suffix}，模型可能太慢或网络不稳。`;
  }

  // 兜底：截断原始信息，别把一整页 HTML 糊到界面上
  const brief = err.replace(/\s+/g, ' ').slice(0, 200);
  return `${brief}${suffix}`;
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY,
  MAX_BACKOFF,
  RETRYABLE_STATUS,
  isRetryable,
  backoffDelay,
  describeFailure
};
