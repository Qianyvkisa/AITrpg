// ---------------------------------------------------------------------------
// 请求重试策略 · 纯逻辑测试
//
// 背景（真实反馈）：跑团跑到一半突然弹出
//   【KP 连接失败】HTTP 502 Bad Gateway
//   {"error":{"message":"模型 xxx 及降级目标全部失败：Loomy chat HTTP 502..."}}
// 502 是上游网关的**瞬时故障**，几秒后往往自己就好了。原来一次抖动就判定失败，
// 自动推进还因此永久停止，玩家只能手动重开——体验上像程序坏了。
//
// 这个文件覆盖：
//   1) 哪些错误值得重试（502/503/504/429/网络），哪些不值得（401/403/404）
//   2) 玩家取消绝不重试
//   3) 退避延迟递增且有上限、有抖动
//   4) 失败文案是「人话」，不会把整页 HTML 糊到界面上
//
// 直接 node tests/retry.test.mjs
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY,
  MAX_BACKOFF,
  isRetryable,
  backoffDelay,
  describeFailure
} = require('../electron/retry.js');

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------------------------------------------------------------------------
console.log('\n== 值得重试：上游瞬时故障 ==');

// 这是用户实际遇到的那一条，必须能重试
ok(
  isRetryable({ ok: false, status: 502, error: 'HTTP 502 Bad Gateway' }),
  '502 网关故障要重试（用户实际遇到的）'
);
ok(isRetryable({ ok: false, status: 503, error: 'HTTP 503' }), '503 要重试');
ok(isRetryable({ ok: false, status: 504, error: 'HTTP 504' }), '504 要重试');
ok(isRetryable({ ok: false, status: 429, error: 'HTTP 429' }), '429 限流要重试');
ok(isRetryable({ ok: false, status: 408, error: 'HTTP 408' }), '408 超时要重试');
ok(isRetryable({ ok: false, status: 500, error: 'HTTP 500' }), '500 要重试');

// 只有文本、没有结构化 status 时，要从 "HTTP 502 ..." 里抠出来
ok(
  isRetryable({ ok: false, error: 'HTTP 502 Bad Gateway\n<html>...</html>' }),
  '没有 status 字段时也能从文本识别 502'
);
ok(
  isRetryable({
    ok: false,
    error: '模型 loomy/DeepSeek-V4.1-Flash 及降级目标全部失败：Loomy chat HTTP 502'
  }),
  '上游那句「及降级目标全部失败」里的 502 也要能识别'
);

// 上游自己报的错误类型
ok(isRetryable({ ok: false, error: 'upstream_error: all_failed' }), 'all_failed 要重试');
ok(isRetryable({ ok: false, error: 'socket hang up' }), 'socket hang up 要重试');
ok(isRetryable({ ok: false, error: 'fetch failed' }), 'fetch failed 要重试');
ok(isRetryable({ ok: false, error: 'read ECONNRESET' }), 'ECONNRESET 要重试');
ok(isRetryable({ ok: false, error: 'connect ETIMEDOUT' }), 'ETIMEDOUT 要重试');

// ---------------------------------------------------------------------------
console.log('\n== 不值得重试：配置错了，重试只是浪费玩家时间 ==');

ok(!isRetryable({ ok: false, status: 401, error: 'HTTP 401 Unauthorized' }), '401 密钥错不重试');
ok(!isRetryable({ ok: false, status: 403, error: 'HTTP 403 Forbidden' }), '403 无权限不重试');
ok(!isRetryable({ ok: false, status: 404, error: 'HTTP 404' }), '404 地址/模型名错不重试');
ok(!isRetryable({ ok: false, status: 400, error: 'HTTP 400' }), '400 请求格式错不重试');
ok(!isRetryable({ ok: false, error: '未配置模型名称' }), '没配模型不重试');
ok(!isRetryable({ ok: false, error: '未配置 API Key' }), '没配 Key 不重试');
ok(!isRetryable({ ok: true, text: 'hi' }), '成功的结果不重试');
ok(!isRetryable(null), 'null 不重试');

// ---------------------------------------------------------------------------
console.log('\n== 玩家取消：绝不重试 ==');

// 这条很关键：如果取消也重试，玩家点了「停止」却发现请求还在跑
ok(
  !isRetryable({ ok: false, canceled: true, error: '请求已取消' }),
  '玩家主动取消不能重试'
);
ok(
  !isRetryable({ ok: false, canceled: true, status: 502, error: 'HTTP 502' }),
  '即使带着可重试的状态码，只要 canceled 就不重试'
);

// ---------------------------------------------------------------------------
console.log('\n== 退避延迟 ==');

eq(DEFAULT_MAX_RETRIES, 2, '默认重试 2 次（总共最多 3 次请求）');
eq(DEFAULT_BASE_DELAY, 800, '首次重试基础等待 800ms');

// 关掉抖动后可以精确断言递增
const d1 = backoffDelay(1, { jitter: false });
const d2 = backoffDelay(2, { jitter: false });
const d3 = backoffDelay(3, { jitter: false });
eq(d1, 800, '第 1 次重试等 800ms');
eq(d2, 1600, '第 2 次重试等 1600ms（翻倍）');
eq(d3, 3200, '第 3 次重试等 3200ms（再翻倍）');
ok(d2 > d1 && d3 > d2, '延迟随重试次数递增');

// 上限：不能让玩家等太久
eq(backoffDelay(20, { jitter: false }), MAX_BACKOFF, '多次重试被上限截住');
ok(backoffDelay(50, { jitter: false }) <= MAX_BACKOFF, '再多次也不超过上限');

// 抖动：多个请求不能整齐地同时重试，否则会把已过载的上游再压一遍
const withJitter = new Set();
for (let i = 0; i < 40; i++) withJitter.add(backoffDelay(1));
ok(withJitter.size > 1, '抖动让每次等待时间不同（避免多请求同步重试）');
ok(
  [...withJitter].every((v) => v >= 600 && v <= 1000),
  '抖动幅度控制在 ±25% 内（800ms → 600~1000ms）'
);

// 非法输入兜底
eq(backoffDelay(0, { jitter: false }), 800, 'attempt 为 0 时按第 1 次算');
eq(backoffDelay(-5, { jitter: false }), 800, 'attempt 为负按第 1 次算');
eq(backoffDelay(NaN, { jitter: false }), 800, 'attempt 为 NaN 按第 1 次算');

// ---------------------------------------------------------------------------
console.log('\n== 失败文案是「人话」 ==');

const html = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>...</body></html>';
const f502 = describeFailure({ status: 502, error: `HTTP 502 Bad Gateway\n${html}` }, 2);
ok(f502.includes('暂时不可用'), '502 文案说明「暂时不可用」');
ok(f502.includes('重试 2 次'), '502 文案带上重试次数');
ok(!f502.includes('<html>'), '502 文案里没有 HTML 标签（不能把上游页面糊给玩家）');

const f401 = describeFailure({ status: 401, error: 'HTTP 401 Unauthorized' });
ok(f401.includes('API Key'), '401 文案指出是 Key 的问题');
ok(f401.includes('设置'), '401 文案告诉玩家去哪里改');

const f404 = describeFailure({ status: 404, error: 'HTTP 404 Not Found' });
ok(f404.includes('模型名') || f404.includes('地址'), '404 文案指出地址或模型名问题');

const f429 = describeFailure({ status: 429, error: 'HTTP 429 Too Many Requests' });
ok(f429.includes('限流'), '429 文案说明被限流');

const fNet = describeFailure({ error: 'connect ECONNREFUSED 127.0.0.1:8080' });
ok(fNet.includes('连不上'), 'ECONNREFUSED 文案说明连不上服务器');

const fTimeout = describeFailure({ error: '请求超时' });
ok(fTimeout.includes('超时'), '超时文案说明超时');

// 兜底：未知错误也要截断，不能把一整页 HTML 糊上去
const fUnknown = describeFailure({ error: 'x'.repeat(1000) });
ok(fUnknown.length <= 260, `未知错误被截断（实际 ${fUnknown.length} 字符）`);
ok(!fUnknown.includes('\n'), '未知错误压成一行');

// 没重试过就不该提「重试」
ok(!describeFailure({ status: 502, error: 'HTTP 502' }).includes('重试 0 次'), '没重试时不提重试次数');

// ---------------------------------------------------------------------------
console.log('\n== 完整场景走查 ==');

{
  // 用户实际遇到的情况：502 → 应该重试 → 若最终仍失败，文案要能看懂
  const res = {
    ok: false,
    status: 502,
    error: '模型 loomy/DeepSeek-V4.1-Flash 及降级目标全部失败：Loomy chat HTTP 502: <html>...'
  };
  ok(isRetryable(res), '用户的 502 属于可重试');
  const msg = describeFailure(res, DEFAULT_MAX_RETRIES);
  ok(msg.includes('暂时不可用'), '最终失败文案说清楚是服务端暂时故障');
  ok(!msg.includes('降级目标'), '不把上游内部术语甩给玩家');
}

{
  // 密钥错：不该浪费三次请求的时间，直接告诉玩家去改
  const res = { ok: false, status: 401, error: 'HTTP 401 Unauthorized' };
  ok(!isRetryable(res), '401 立刻失败，不做无谓重试');
}

{
  // 玩家点取消：必须立刻停，不能又发两次请求
  const res = { ok: false, canceled: true, error: '请求已取消' };
  ok(!isRetryable(res), '取消立刻返回');
}

// ---------------------------------------------------------------------------
console.log('\n==========================================');
if (failed === 0) {
  console.log(`通过 ${passed} 项，全部通过`);
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
