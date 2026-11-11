// ---------------------------------------------------------------------------
// 旁观模式「自动推进」逻辑测试
//
// 自动推进的风险全在「该停的时候没停」：
//   1) 骰子还没掷就推进 → KP 会叙述一个虚构的结果，故事线和真实骰点错位
//   2) 剧情结束了还在推进 → 白烧 token，玩家还看到一堆莫名其妙的续写
//   3) 用户点了停止 / 回主界面，定时器还在 → 离开界面后突然又发一次请求
//   4) 一次请求没跑完又排下一次 → 两条叙述交叉插入，消息顺序乱掉
//
// 直接 node tests/autoAdvance.test.mjs
// ---------------------------------------------------------------------------

import {
  AUTO_ADVANCE_MAX_TURNS,
  AUTO_RECOVER_MAX,
  DEFAULT_DELAY,
  MIN_DELAY,
  MAX_DELAY,
  autoAdvanceBlocker,
  isTerminalBlocker,
  isRecoverableFailure,
  shouldReportBlocker,
  blockerMessage,
  clampDelay,
  readAutoAdvanceState,
  recoveryDelay
} from '../src/core/autoAdvance.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/** 构造一份「一切正常、可以推进」的参数，各用例只改自己关心的字段 */
function base(over = {}) {
  return {
    mode: 'spectator',
    autoAdvance: true,
    busy: false,
    ended: false,
    pendingRoll: false,
    turns: 3,
    ...over
  };
}

// ---------------------------------------------------------------------------
console.log('\n== 正常情况：该推进时返回 null ==');

eq(autoAdvanceBlocker(base()), null, '旁观模式 + 开关开 + 无阻塞 → 可以推进');
eq(autoAdvanceBlocker(base({ turns: 0 })), null, '刚开局（0 轮）可以推进');
eq(autoAdvanceBlocker(base({ turns: AUTO_ADVANCE_MAX_TURNS - 1 })), null, '未达上限时可以推进');

// ---------------------------------------------------------------------------
console.log('\n== 玩家模式永远不推进 ==');

eq(autoAdvanceBlocker(base({ mode: 'player' })), 'not-spectator', '玩家模式不自动推进');
eq(
  autoAdvanceBlocker(base({ mode: 'player', autoAdvance: false })),
  'not-spectator',
  '玩家模式即使开关为 false 也报 not-spectator（模式优先级最高）'
);
// 模式判断必须排在开关判断之前：否则玩家模式下会被当成「开关关着」，
// 界面就不会把按钮藏起来
ok(
  autoAdvanceBlocker(base({ mode: 'player' })) === 'not-spectator',
  '模式判断优先于开关判断'
);

// ---------------------------------------------------------------------------
console.log('\n== 开关关闭 ==');

eq(autoAdvanceBlocker(base({ autoAdvance: false })), 'off', '开关关着 → off');

// ---------------------------------------------------------------------------
console.log('\n== 请求进行中不重复触发 ==');

eq(autoAdvanceBlocker(base({ busy: true })), 'busy', '上一次请求没跑完 → busy');

// ---------------------------------------------------------------------------
console.log('\n== 剧情结束必须停 ==');

eq(autoAdvanceBlocker(base({ ended: true })), 'ended', '剧情已结束 → ended');
// 结束的优先级高于 pending-roll：剧情都结束了，骰子掷不掷都不该再推进
eq(
  autoAdvanceBlocker(base({ ended: true, pendingRoll: true })),
  'ended',
  '剧情结束 + 有待掷骰 → 仍报 ended（结束优先）'
);

// ---------------------------------------------------------------------------
console.log('\n== 有待掷骰必须停 ==');

eq(autoAdvanceBlocker(base({ pendingRoll: true })), 'pending-roll', '有检定没掷 → pending-roll');
// 这条是最要紧的：骰点未定就推进，KP 会基于「未发生的结果」往下写
ok(
  autoAdvanceBlocker(base({ pendingRoll: true })) !== null,
  '骰点未定时绝不推进（防止 KP 编造结果）'
);

// ---------------------------------------------------------------------------
console.log('\n== 轮数上限 ==');

eq(
  autoAdvanceBlocker(base({ turns: AUTO_ADVANCE_MAX_TURNS })),
  'max-turns',
  `达到 ${AUTO_ADVANCE_MAX_TURNS} 轮 → max-turns`
);
eq(
  autoAdvanceBlocker(base({ turns: AUTO_ADVANCE_MAX_TURNS + 50 })),
  'max-turns',
  '超过上限仍报 max-turns'
);
// 自定义上限要生效
eq(autoAdvanceBlocker(base({ turns: 5, maxTurns: 5 })), 'max-turns', '自定义 maxTurns 生效');
eq(autoAdvanceBlocker(base({ turns: 4, maxTurns: 5 })), null, '未达自定义上限可以推进');
// turns 缺失 / 非法值当作 0，不能因此误判成「已到上限」
eq(autoAdvanceBlocker(base({ turns: undefined })), null, 'turns 缺失时按 0 处理');
eq(autoAdvanceBlocker(base({ turns: NaN })), null, 'turns 是 NaN 时按 0 处理');
eq(autoAdvanceBlocker(base({ turns: -5 })), null, 'turns 为负数时按 0 处理');

// ---------------------------------------------------------------------------
console.log('\n== 上限用的是「连续自动推进轮数」而不是整局轮数 ==');

// 这是真实事故的回归测试：上限原本读 state.turns（整局轮数），
// 于是一局玩到 200 轮就永久开不了自动推进。现在读 state.autoAdvanceRun。
const longGame = {
  mode: 'spectator',
  autoAdvance: true,
  turns: 5000,          // 整局已经玩了 5000 轮
  autoAdvanceRun: 3     // 但连续自动推进只有 3 轮
};
eq(
  autoAdvanceBlocker(readAutoAdvanceState(longGame)),
  null,
  '整局轮数再多，只要连续自动推进没超限就能继续'
);
eq(
  readAutoAdvanceState(longGame).turns,
  3,
  'readAutoAdvanceState 读的是 autoAdvanceRun，不是 turns'
);
eq(
  autoAdvanceBlocker(readAutoAdvanceState({ mode: 'spectator', autoAdvance: true, autoAdvanceRun: AUTO_ADVANCE_MAX_TURNS })),
  'max-turns',
  '连续自动推进达到上限 → max-turns'
);
// 缺少 autoAdvanceRun 字段（旧存档）时按 0 处理，不能误判成已到上限
eq(
  autoAdvanceBlocker(readAutoAdvanceState({ mode: 'spectator', autoAdvance: true, turns: 9999 })),
  null,
  '旧存档没有 autoAdvanceRun 字段时按 0 处理，不误判'
);

// ---------------------------------------------------------------------------
console.log('\n== 该不该打扰玩家 ==');

ok(!shouldReportBlocker('off'), '开关关着不提示（玩家自己关的）');
ok(!shouldReportBlocker('busy'), '请求进行中不提示（等它跑完自然继续）');
ok(!shouldReportBlocker('not-spectator'), '模式不对不提示（按钮本来就没显示）');
ok(!shouldReportBlocker(null), 'null 不提示');
ok(shouldReportBlocker('ended'), '剧情结束要提示');
ok(shouldReportBlocker('pending-roll'), '有待掷骰要提示');
ok(shouldReportBlocker('max-turns'), '到上限要提示');

// ---------------------------------------------------------------------------
console.log('\n== 终局 vs 暂时（决定开关要不要关掉）==');

// 这条区分是自动推进能不能「掷完骰自动接上」的关键：
// 把 pending-roll 当成终局去关开关，玩家掷完骰就得再手动开一次，很别扭。
ok(isTerminalBlocker('ended'), 'ended 是终局 → 关掉开关');
// max-turns 曾经被当成终局，后果是一局推到上限后**永久**开不了自动推进
// （toggle 直接拒绝），玩家只能重开游戏。它本质只是防失控的保护，
// 玩家手动推一次就该能继续，所以现在归到「可恢复」这一类。
ok(!isTerminalBlocker('max-turns'), 'max-turns 可恢复 → 不关开关（手动推一次即继续）');
ok(!isTerminalBlocker('pending-roll'), 'pending-roll 只是暂时 → 开关保持开着');
ok(!isTerminalBlocker('busy'), 'busy 只是暂时 → 开关保持开着');
ok(!isTerminalBlocker('off'), 'off 不是终局');
ok(!isTerminalBlocker('not-spectator'), 'not-spectator 不是终局');
ok(!isTerminalBlocker(null), 'null 不是终局');

// ---------------------------------------------------------------------------
console.log('\n== 提示文案 ==');

ok(blockerMessage('ended').includes('结束'), 'ended 文案含「结束」');
ok(blockerMessage('pending-roll').includes('掷骰'), 'pending-roll 文案含「掷骰」');
ok(blockerMessage('max-turns').includes('上限'), 'max-turns 文案含「上限」');
eq(blockerMessage('off'), '', 'off 没有文案');
eq(blockerMessage(null), '', 'null 没有文案');
ok(
  blockerMessage('max-turns', 50).includes('50'),
  'max-turns 文案带上具体轮数'
);

// ---------------------------------------------------------------------------
console.log('\n== 间隔夹取 ==');

eq(clampDelay(2000), 2000, '正常值原样返回');
eq(clampDelay(1), MIN_DELAY, `过小夹到下限 ${MIN_DELAY}`);
eq(clampDelay(0), DEFAULT_DELAY, '0 回落到默认值');
eq(clampDelay(-100), DEFAULT_DELAY, '负数回落到默认值');
eq(clampDelay(999999), MAX_DELAY, `过大夹到上限 ${MAX_DELAY}`);
eq(clampDelay(undefined), DEFAULT_DELAY, 'undefined 回落默认值');
eq(clampDelay('3000'), 3000, '字符串数字能解析');
eq(clampDelay('abc'), DEFAULT_DELAY, '非数字字符串回落默认值');
eq(clampDelay(NaN), DEFAULT_DELAY, 'NaN 回落默认值');
eq(clampDelay(2000.7), 2001, '小数四舍五入');

// ---------------------------------------------------------------------------
console.log('\n== 从 state 提取参数 ==');

{
  const s = {
    mode: 'spectator',
    autoAdvance: true,
    scenario: { ended: false },
    turns: 7,            // 整局轮数：不再用作上限
    autoAdvanceRun: 7    // 连续自动推进轮数：现在读的是这个
  };
  const r = readAutoAdvanceState(s, { busy: true, pendingRoll: false });
  eq(r.mode, 'spectator', 'mode 正确提取');
  eq(r.autoAdvance, true, 'autoAdvance 正确提取');
  eq(r.busy, true, 'busy 正确提取');
  eq(r.ended, false, 'ended 正确提取');
  eq(r.pendingRoll, false, 'pendingRoll 正确提取');
  eq(r.turns, 7, 'turns 正确提取（取自 autoAdvanceRun）');
}
{
  // 整局轮数与连续轮数不一致时，必须取连续轮数
  const r = readAutoAdvanceState({ mode: 'spectator', turns: 300, autoAdvanceRun: 2 });
  eq(r.turns, 2, '整局 300 轮但连续只有 2 轮 → 取 2（回归：曾误取整局轮数）');
}
{
  // scenario 缺失不能抛异常
  const r = readAutoAdvanceState({ mode: 'player' });
  eq(r.ended, false, 'scenario 缺失时 ended 兜底 false');
  eq(r.turns, 0, 'turns 缺失时兜底 0');
  eq(r.autoAdvance, false, 'autoAdvance 缺失时兜底 false');
}
{
  const r = readAutoAdvanceState(null);
  eq(r.mode, 'player', 'state 为 null 时 mode 兜底 player');
  eq(r.turns, 0, 'state 为 null 时 turns 兜底 0');
}
{
  const r = readAutoAdvanceState({ scenario: { ended: true } });
  eq(r.ended, true, 'scenario.ended 正确读到');
}

// ---------------------------------------------------------------------------
console.log('\n== 完整场景走查 ==');

{
  // 场景：旁观模式跑 5 轮后剧情结束
  let s = { mode: 'spectator', autoAdvance: true, scenario: { ended: false }, turns: 0 };
  let steps = 0;
  while (steps < 10) {
    const blocker = autoAdvanceBlocker(readAutoAdvanceState(s, {}));
    if (blocker) break;
    s = { ...s, turns: s.turns + 1, scenario: { ended: s.turns + 1 >= 5 } };
    steps++;
  }
  eq(steps, 5, '跑满 5 轮后停下（不多推）');
  eq(s.scenario.ended, true, '第 5 轮剧情结束');
}

{
  // 场景：推进中突然出现待掷骰 → 停下，掷完后能继续
  const blocked = base({ pendingRoll: true });
  eq(autoAdvanceBlocker(blocked), 'pending-roll', '出现待掷骰时停下');
  const resumed = { ...blocked, pendingRoll: false };
  eq(autoAdvanceBlocker(resumed), null, '骰子掷完后可以继续');
}

{
  // 场景：用户中途关掉开关
  eq(autoAdvanceBlocker(base({ autoAdvance: false })), 'off', '用户关掉后不再推进');
}

// ---------------------------------------------------------------------------
console.log('\n== 故障是否值得自动重试（isRecoverableFailure） ==');

{
  // 暂时性故障：等一会儿大概率就通，应该自动重试
  for (const msg of [
    '模型服务暂时不可用（HTTP 502），上游网关故障，通常过一会儿会自己恢复（已自动重试 2 次）。',
    '请求太频繁被限流了（HTTP 429），等几十秒再继续。',
    'HTTP 503 Service Unavailable',
    'HTTP 504 gateway timeout',
    '连不上 API 服务器（已自动重试 2 次），检查网络或 API 地址是否正确。',
    '请求超时（已自动重试 2 次），模型可能太慢或网络不稳。',
    'fetch failed',
    'ECONNRESET socket hang up'
  ]) {
    ok(isRecoverableFailure(msg), `可恢复：${msg.slice(0, 24)}…`);
  }
}

{
  // 配置类错误：重试一百次也一样，只会让玩家多等
  for (const msg of [
    'API Key 无效或没有权限（HTTP 401），请到设置里检查密钥。',
    '接口地址或模型名不存在（HTTP 404），请到设置里检查 API 地址与模型名。',
    'HTTP 403 Forbidden',
    '未配置模型名称',
    '请先填写 API Key',
    '未配置 API Key'
  ]) {
    ok(!isRecoverableFailure(msg), `不可恢复：${msg.slice(0, 24)}…`);
  }
}

{
  // 未知错误不自动重试：宁可停下让玩家看到，也别无声地反复重试
  eq(isRecoverableFailure(''), false, '空错误不重试');
  eq(isRecoverableFailure(null), false, 'null 不重试');
  eq(isRecoverableFailure(undefined), false, 'undefined 不重试');
  eq(isRecoverableFailure('某个我完全没见过的奇怪错误'), false, '未知错误不重试');
}

{
  // 「HTTP 502」和「API Key」同时出现时，以配置错误为准（先排除）
  ok(!isRecoverableFailure('HTTP 502 但 API Key 未配置'), '配置错误优先于状态码');
}

{
  // 欠费/积分用完被网关包成 502：这是账户问题，重试无用，绝不能判成可恢复。
  // 真实踩过：外层 502 让程序以为是网关抖动，于是一直自动重试，
  // 玩家永远看不到「去充值」这个真正该做的事。
  for (const msg of [
    '模型账户余额不足或积分用完了，请到服务商那里充值后再试（账户问题，重试不会恢复）。',
    '模型服务暂时不可用（HTTP 502），但实际原因是 insufficient_quota',
    'HTTP 502 积分余额不足'
  ]) {
    ok(!isRecoverableFailure(msg), `欠费不可恢复：${msg.slice(0, 20)}…`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 重试退避（recoveryDelay） ==');

{
  eq(recoveryDelay(1), 5000, '第 1 次 5 秒');
  eq(recoveryDelay(2), 10000, '第 2 次 10 秒');
  eq(recoveryDelay(3), 20000, '第 3 次 20 秒');
  eq(recoveryDelay(4), 30000, '第 4 次封顶 30 秒');
  eq(recoveryDelay(99), 30000, '极大值仍封顶 30 秒');

  ok(recoveryDelay(1) > DEFAULT_DELAY, '重试间隔比正常推进间隔长（避免原速猛打）');

  // 非法输入按第 1 次处理，不能返回 NaN 或 0（否则定时器立刻触发）
  eq(recoveryDelay(0), 5000, '0 按第 1 次处理');
  eq(recoveryDelay(-5), 5000, '负数按第 1 次处理');
  eq(recoveryDelay('abc'), 5000, '非数字按第 1 次处理');
  ok(recoveryDelay(NaN) > 0, 'NaN 也返回正数');
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(42));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('全部通过');
}
