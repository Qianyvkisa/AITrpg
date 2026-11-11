// ---------------------------------------------------------------------------
// 端到端：502 时自动推进不该要求玩家手动点
//
// 为什么需要这个测试：
//   autoAdvanceRunner 的单元测试覆盖了 recoverAfterFailure 本身，但真实的
//   bug 发生在**接线处**——app.js 的 finally 里有 resumeAutoAdvanceIfNeeded()，
//   它在失败分支 return 之后仍会执行，会把 recoverAfterFailure 排好的退避
//   定时器覆盖成正常间隔（2s），或者把「暂停」变成无限重试。
//
//   这类「两个正确的东西接在一起就错了」的问题，单测抓不到。
//   这里用最小桩模拟 spectatorAdvance 的失败路径，断言最终排程的间隔。
// ---------------------------------------------------------------------------

import { createAutoAdvanceRunner } from '../src/core/autoAdvanceRunner.js';
import { DEFAULT_DELAY } from '../src/core/autoAdvance.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/**
 * 复刻 app.js 里 spectatorAdvance 的失败路径（保持结构一致）。
 *
 * 这段是**照抄** app.js 的：无法 import，因为 app.js 依赖整个界面栈。
 * 这是本仓库已知的技术债（见 MAINTAINING.md）。为了让它不至于形同虚设，
 * 关键结构（failed 标志 + finally 里的条件 resume）必须与真实代码同步。
 */
function makeAdvanceHarness({ takeTurnResult, autoAdvance = true } = {}) {
  const state = {
    mode: 'spectator',
    autoAdvance,
    autoAdvanceDelay: DEFAULT_DELAY,
    turns: 0,
    autoAdvanceRun: 0,
    scenario: { ended: false }
  };

  const notes = [];
  const timers = new Map();
  let nextId = 1;
  let busy = false;

  const runner = createAutoAdvanceRunner({
    getState: () => state,
    isBusy: () => busy,
    hasPendingRoll: () => false,
    runTurn: async () => {},
    notify: (t) => notes.push(t),
    onChange: () => {},
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); }
  });

  /** 模拟一次推进（含失败处理与 finally） */
  async function advance({ fromAuto = false } = {}) {
    if (busy) return;
    if (!fromAuto) {
      runner.cancel();
      runner.resetRunCount();
    }
    busy = true;
    let failed = false;
    try {
      const res = takeTurnResult;
      if (res?.ok === false) {
        const friendly = res.error || '模型服务暂时不可用';
        failed = true;
        runner.recoverAfterFailure(friendly);
        return;
      }
      runner.noteSuccess();
      state.turns += 1;
    } finally {
      busy = false;
      if (!failed) runner.resume();
    }
  }

  return {
    state, runner, notes, timers, advance,
    pendingTimers: () => timers.size,
    timerMs: () => [...timers.values()][0]?.ms ?? null
  };
}

// ---------------------------------------------------------------------------
console.log('\n== 502 失败后：退避重试不被 finally 的 resume 覆盖 ==');

{
  const h = makeAdvanceHarness({
    takeTurnResult: {
      ok: false,
      error: '模型服务暂时不可用（HTTP 502），上游网关故障，通常过一会儿会自己恢复（已自动重试 2 次）。'
    }
  });
  h.state.autoAdvance = true;

  await h.advance({ fromAuto: true });

  eq(h.pendingTimers(), 1, '排了一个定时器');
  eq(h.timerMs(), 5000, '间隔是退避的 5 秒，不是正常推进的 2 秒');
  ok(h.timerMs() !== DEFAULT_DELAY, '没有被 finally 的 resume 覆盖成 2 秒');
  eq(h.state.autoAdvance, true, '开关保持开启');
  eq(h.state.turns, 0, '失败不计轮数（避免轮数虚增）');

  const note = h.notes.join(' | ');
  ok(/自动重试/.test(note), '提示告知正在自动重试');
  ok(!/点「推进」即可继续/.test(note), '不再要求玩家手动点推进');
}

// ---------------------------------------------------------------------------
console.log('\n== 401 失败后：真的暂停，不偷偷重试 ==');

{
  const h = makeAdvanceHarness({
    takeTurnResult: {
      ok: false,
      error: 'API Key 无效或没有权限（HTTP 401），请到设置里检查密钥。'
    }
  });
  h.state.autoAdvance = true;

  await h.advance({ fromAuto: true });

  eq(h.pendingTimers(), 0, '不排定时器');
  eq(h.state.autoAdvance, true, '开关仍开着（玩家修好配置后能直接继续）');

  const note = h.notes.join(' | ');
  ok(/需要处理/.test(note), '提示这是需要玩家处理的问题');
  ok(!/自动重试/.test(note), '不谎称在自动重试');
}

// ---------------------------------------------------------------------------
console.log('\n== 连续失败：退避递增，超上限后停止 ==');

{
  const h = makeAdvanceHarness({
    takeTurnResult: { ok: false, error: '模型服务暂时不可用（HTTP 502），上游网关故障。' }
  });
  h.state.autoAdvance = true;

  const waits = [];
  for (let i = 0; i < 3; i++) {
    await h.advance({ fromAuto: true });
    waits.push(h.timerMs());
  }
  eq(waits[0], 5000, '第 1 次 5 秒');
  eq(waits[1], 10000, '第 2 次 10 秒');
  eq(waits[2], 20000, '第 3 次 20 秒');

  // 第 4 次超过上限，应彻底停止
  await h.advance({ fromAuto: true });
  eq(h.pendingTimers(), 0, '超过重试上限后不再排定时器');
  ok(/连续 3 次/.test(h.notes.join(' | ')), '提示连续失败次数');
}

// ---------------------------------------------------------------------------
console.log('\n== 成功后失败计数清零，下次故障有完整预算 ==');

{
  const h = makeAdvanceHarness({
    takeTurnResult: { ok: false, error: 'HTTP 502 网关故障' }
  });
  h.state.autoAdvance = true;

  await h.advance({ fromAuto: true });
  eq(h.runner.failureCount(), 1, '失败一次');
  h.runner.cancel();

  // 模拟一次成功
  h.state.turns += 0;
  h.runner.noteSuccess();
  eq(h.runner.failureCount(), 0, '成功后清零');

  await h.advance({ fromAuto: true });
  eq(h.runner.failureCount(), 1, '再次失败从 1 开始，退避回到 5 秒');
  eq(h.timerMs(), 5000, '退避重置为 5 秒');
}

// ---------------------------------------------------------------------------
console.log('\n== 成功路径不受影响：仍然按 2 秒正常推进 ==');

{
  const h = makeAdvanceHarness({ takeTurnResult: { ok: true } });
  h.state.autoAdvance = true;

  await h.advance({ fromAuto: true });

  eq(h.pendingTimers(), 1, '成功后排下一轮');
  eq(h.timerMs(), DEFAULT_DELAY, '用正常间隔 2 秒');
  eq(h.state.turns, 1, '成功计一轮');
  eq(h.runner.failureCount(), 0, '失败计数为 0');
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
