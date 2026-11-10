// ---------------------------------------------------------------------------
// 自动推进调度器 · 真实实现测试
//
// 这个文件测的是 src/core/autoAdvanceRunner.js **本身**，不是抄件。
// 注入假定时器，可以直接推进时间、断言排程与恢复行为。
//
// 覆盖的核心场景（都是曾经真实出问题的地方）：
//   1) 手动推进之后，定时器必须被重建（这就是「自动推进没效果」的根因）
//   2) busy 时点开关不能静默失败
//   3) 待掷骰时点开关要打开开关并说明在等什么
//   4) 剧情结束 / 轮数上限 → 停掉并提示
//   5) 关掉开关后不能再有排程
//   6) runTurn 抛异常后不能永久卡死
//
// 直接 node tests/autoAdvanceRunner.test.mjs
// ---------------------------------------------------------------------------

import { createAutoAdvanceRunner } from '../src/core/autoAdvanceRunner.js';
import { DEFAULT_DELAY, MIN_DELAY, MAX_DELAY, AUTO_ADVANCE_MAX_TURNS } from '../src/core/autoAdvance.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------------------------------------------------------------------------
// 测试基架：假定时器 + 可控 state
// ---------------------------------------------------------------------------
function makeHarness(overrides = {}) {
  const state = {
    mode: 'spectator',
    autoAdvance: false,
    autoAdvanceDelay: DEFAULT_DELAY,
    turns: 0,
    // 连续自动推进轮数：上限看的是这个，不是整局 turns
    autoAdvanceRun: 0,
    scenario: { ended: false },
    ...overrides
  };

  const notes = [];       // notify 收到的系统提示
  let busy = false;
  let pendingRoll = false;
  let changeCount = 0;

  // 假定时器：记录所有排程，可手动「走到点」
  const timers = new Map();
  let nextId = 1;

  const setTimer = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimer = (id) => { timers.delete(id); };

  let turnCount = 0;
  let turnImpl = async () => { turnCount++; };

  const runner = createAutoAdvanceRunner({
    getState: () => state,
    isBusy: () => busy,
    hasPendingRoll: () => pendingRoll,
    runTurn: () => turnImpl(),
    notify: (t) => notes.push(t),
    onChange: () => { changeCount++; },
    setTimer,
    clearTimer
  });

  /** 触发唯一挂起的定时器（模拟时间到点） */
  async function fireTimer() {
    const entry = [...timers.entries()][0];
    if (!entry) return false;
    const [id, t] = entry;
    timers.delete(id);
    await t.fn();
    return true;
  }

  return {
    state,
    runner,
    notes,
    timers,
    get busy() { return busy; },
    set busy(v) { busy = v; },
    get pendingRoll() { return pendingRoll; },
    set pendingRoll(v) { pendingRoll = v; },
    get changeCount() { return changeCount; },
    get turnCount() { return turnCount; },
    set turnImpl(fn) { turnImpl = fn; },
    fireTimer,
    pendingTimers: () => timers.size
  };
}

// ---------------------------------------------------------------------------
console.log('\n== 基础：开启 → 排程 → 触发 → 跑一轮 ==');

{
  const h = makeHarness();
  h.runner.toggle();

  eq(h.state.autoAdvance, true, 'toggle 后开关打开');
  eq(h.pendingTimers(), 1, '排了一个定时器');
  eq(h.changeCount, 1, '通知界面刷新了一次');

  await h.fireTimer();
  eq(h.turnCount, 1, '定时器到点跑了一轮');
  eq(h.pendingTimers(), 1, '跑完后自动排下一轮');
  eq(h.state.autoAdvance, true, '开关保持打开');
}

// ---------------------------------------------------------------------------
console.log('\n== 默认间隔是 2 秒 ==');

{
  const h = makeHarness();
  h.runner.toggle();
  const t = [...h.timers.values()][0];
  eq(t.ms, 2000, '默认间隔 2000ms');
  eq(DEFAULT_DELAY, 2000, 'DEFAULT_DELAY 常量是 2000');
}

// ---------------------------------------------------------------------------
console.log('\n== 回归：手动推进后定时器必须重建（原 bug）==');

{
  const h = makeHarness();
  h.runner.toggle();
  eq(h.pendingTimers(), 1, '开启后有一个定时器');

  // 用户没耐心，手动点「推进」：界面层会先 cancel 再跑一轮
  h.runner.cancel();
  eq(h.pendingTimers(), 0, '手动推进先清掉定时器');

  // 这一轮跑完后，界面层调用 resume（app.js 的 finally 里）
  h.runner.resume();

  eq(h.pendingTimers(), 1, '★ 手动推进跑完后定时器被重建了');
  eq(h.state.autoAdvance, true, '开关仍然打开');

  // 再触发一次，确认真的能继续自动跑
  await h.fireTimer();
  eq(h.turnCount, 1, '重建的定时器能正常触发');

  // 不 resume 的情况：这就是修复前的行为，应当**没有**排程
  const h2 = makeHarness();
  h2.runner.toggle();
  h2.runner.cancel();
  eq(h2.pendingTimers(), 0, '（对照）不调用 resume 就没有排程——修复前正是这样');
}

// ---------------------------------------------------------------------------
console.log('\n== resume 的幂等性：不重置已在跑的倒计时 ==');

{
  const h = makeHarness();
  h.runner.toggle();
  const before = [...h.timers.keys()][0];

  h.runner.resume();  // 已经在计时
  eq(h.pendingTimers(), 1, '仍然只有一个定时器');
  eq([...h.timers.keys()][0], before, '定时器 id 没变（没被重置倒计时）');
}

// ---------------------------------------------------------------------------
console.log('\n== busy 时点开关：不能静默失败 ==');

{
  const h = makeHarness();
  h.busy = true;

  h.runner.toggle();

  eq(h.state.autoAdvance, true, '★ busy 时点开关照样把开关打开（不再静默失败）');
  eq(h.pendingTimers(), 0, 'busy 时不排定时器（排了也会被挡回）');

  // 这一轮跑完后界面层会 resume
  h.busy = false;
  h.runner.resume();
  eq(h.pendingTimers(), 1, '请求结束后 resume 接上了');
}

// ---------------------------------------------------------------------------
console.log('\n== 待掷骰时点开关：打开并说明在等什么 ==');

{
  const h = makeHarness();
  h.pendingRoll = true;

  h.runner.toggle();

  eq(h.state.autoAdvance, true, '待掷骰时也把开关打开');
  eq(h.pendingTimers(), 0, '待掷骰时不排定时器');
  ok(
    h.notes.some((n) => n.includes('掷骰')),
    '给了「等你掷骰」的提示'
  );

  // 掷完骰 → resume 接上
  h.pendingRoll = false;
  h.runner.resume();
  eq(h.pendingTimers(), 1, '掷完骰后自动接上');
}

// ---------------------------------------------------------------------------
console.log('\n== 剧情结束：拒绝开启并说明原因 ==');

{
  const h = makeHarness({ scenario: { ended: true } });
  h.runner.toggle();

  eq(h.state.autoAdvance, false, '剧情已结束时不开开关');
  eq(h.pendingTimers(), 0, '不排定时器');
  ok(h.notes.some((n) => n.includes('结束')), '提示剧情已结束');
}

// ---------------------------------------------------------------------------
console.log('\n== 轮数上限：停掉并提示 ==');

// 真实事故的回归测试：自动推进跑到上限后，玩家**必须还能继续**。
//
// 旧实现把 max-turns 当终局，toggle 里直接拒绝开启，于是玩家卡死在
// 「已达到自动推进上限（200 轮）」上，除了重开游戏没有别的办法。
// 而且上限读的是整局 turns，正常玩一局必然会撞上。
{
  const h = makeHarness({ autoAdvanceRun: AUTO_ADVANCE_MAX_TURNS });
  h.runner.toggle();

  eq(h.state.autoAdvance, true, '到上限后仍能开启自动推进（不再是永久拒绝）');
  eq(h.state.autoAdvanceRun, 0, '开启时连续计数被清零');
  eq(h.pendingTimers(), 1, '清零后立刻排上了定时器');
}

// 整局轮数再多也不该影响：上限只看连续自动推进轮数
{
  const h = makeHarness({ turns: 5000, autoAdvanceRun: 2 });
  h.runner.toggle();
  eq(h.state.autoAdvance, true, '整局 5000 轮仍可开启（上限不看整局轮数）');
  eq(h.pendingTimers(), 1, '正常排上定时器');
  ok(!h.notes.some((n) => n.includes('上限')), '没有误报上限提示');
}

// 自动推进跑着跑着撞到上限：暂停但不关开关，玩家手动推一次即可继续
{
  const h = makeHarness({ autoAdvanceRun: AUTO_ADVANCE_MAX_TURNS });
  h.state.autoAdvance = true;          // 假装开关已经开着
  h.runner.resume();                   // 到上限了，排不上
  eq(h.pendingTimers(), 0, '到上限时不再排程');

  // 玩家手动推一次 → 计数清零 → 自动推进重新接上
  h.runner.resetRunCount();
  eq(h.state.autoAdvanceRun, 0, '手动操作后计数清零');
  h.runner.resume();
  eq(h.pendingTimers(), 1, '清零后自动推进重新接上');
  eq(h.state.autoAdvance, true, '开关始终没被关掉');
}

// ---------------------------------------------------------------------------
console.log('\n== 定时器到点时剧情已结束：停掉不跑 ==');

{
  const h = makeHarness();
  h.runner.toggle();
  eq(h.pendingTimers(), 1, '先有一个定时器');

  h.state.scenario.ended = true;   // 排队期间剧情结束了
  await h.fireTimer();

  eq(h.turnCount, 0, '没有跑这一轮');
  eq(h.state.autoAdvance, false, '开关被关掉');
  ok(h.notes.some((n) => n.includes('结束')), '提示剧情已结束');
}

// ---------------------------------------------------------------------------
console.log('\n== 关掉开关后不再有排程 ==');

{
  const h = makeHarness();
  h.runner.toggle();
  eq(h.pendingTimers(), 1, '开启后有排程');

  h.runner.toggle();  // 再点一次 = 关闭
  eq(h.state.autoAdvance, false, '开关关闭');
  eq(h.pendingTimers(), 0, '定时器被清掉');

  // 关闭后 resume 不应复活它
  h.runner.resume();
  eq(h.pendingTimers(), 0, '关闭状态下 resume 不会复活定时器');
}

// ---------------------------------------------------------------------------
console.log('\n== runTurn 抛异常后不能永久卡死 ==');

{
  const h = makeHarness();
  h.runner.toggle();

  h.turnImpl = async () => { throw new Error('模拟网络错误'); };
  await h.fireTimer();

  eq(h.runner.isRunning(), false, 'running 标记已复位（不会卡死）');
  // 开关还开着 → 应该继续排下一轮，让玩家能等到网络恢复
  eq(h.pendingTimers(), 1, '异常后仍排了下一轮（开关没被意外关掉）');

  // 恢复正常后能继续跑
  h.turnImpl = async () => {};
  await h.fireTimer();
  ok(true, '异常之后能恢复运行');
}

// ---------------------------------------------------------------------------
console.log('\n== 玩家模式：开关无效 ==');

{
  const h = makeHarness({ mode: 'player' });
  h.runner.toggle();

  eq(h.state.autoAdvance, false, '玩家模式点开关无效');
  eq(h.pendingTimers(), 0, '不排定时器');
}

// ---------------------------------------------------------------------------
console.log('\n== 间隔夹取仍然生效 ==');

{
  const h = makeHarness({ autoAdvanceDelay: 1 });
  h.runner.toggle();
  eq([...h.timers.values()][0].ms, MIN_DELAY, '过小的间隔夹到下限');

  const h2 = makeHarness({ autoAdvanceDelay: 999999 });
  h2.runner.toggle();
  eq([...h2.timers.values()][0].ms, MAX_DELAY, '过大的间隔夹到上限');
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
