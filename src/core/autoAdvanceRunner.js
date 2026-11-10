// ---------------------------------------------------------------------------
// 旁观模式「自动推进」的调度器
//
// 为什么要把这段从 app.js 里抽出来：
//
// 原来定时器、开关、恢复逻辑全都塞在 app.js 里，而 app.js 依赖整个界面栈
// （引擎、渲染、Electron API），node 里没法直接 import。于是测试只能把那段
// 逻辑**照抄一份**来测——抄件永远跟着测试一起改，真实代码改坏了测试照样绿。
//
// 这不是假设。真实发生过的 bug：手动点「推进」时 cancelAutoAdvance() 清掉了
// 定时器，但每轮结束时没人重建，于是开关亮着、按钮显示「自动推进 · 开」，
// 却再也不动。照抄的测试因为同步抄了「有 resume」的版本，完全没发现。
//
// 所以这里只保留纯调度逻辑，把「怎么设定时器」「怎么跑一轮」「怎么通知界面」
// 全部做成注入参数。测试可以直接 import 这个模块，注入假定时器，
// 断言的就是**真实在跑的代码**。
// ---------------------------------------------------------------------------

import {
  AUTO_ADVANCE_MAX_TURNS,
  autoAdvanceBlocker,
  blockerMessage,
  clampDelay,
  isTerminalBlocker,
  readAutoAdvanceState
} from './autoAdvance.js';

/**
 * 创建自动推进调度器。
 *
 * @param {object} deps
 * @param {() => object} deps.getState        取当前 state（要能读到 mode/autoAdvance/autoAdvanceDelay/turns/scenario）
 * @param {() => boolean} deps.isBusy         是否有请求在跑
 * @param {() => boolean} deps.hasPendingRoll 是否有等玩家掷的骰
 * @param {() => Promise<void>} deps.runTurn  跑一轮（通常是 spectatorAdvance）
 * @param {(text: string) => void} [deps.notify]        往消息流里推一条系统提示
 * @param {() => void} [deps.onChange]                  开关状态变了，通知界面刷新按钮
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]   可注入，默认 setTimeout
 * @param {(id: any) => void} [deps.clearTimer]                 可注入，默认 clearTimeout
 * @returns {{toggle, schedule, cancel, stop, resume, isTimerPending, isRunning}}
 */
export function createAutoAdvanceRunner({
  getState,
  isBusy,
  hasPendingRoll,
  runTurn,
  notify = () => {},
  onChange = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
}) {
  /** 挂起的定时器 id（null = 没有排程） */
  let timerId = null;
  /** 是否正在跑 runTurn，防止并发重入 */
  let running = false;

  /**
   * 算出当前阻止原因。
   *
   * @param {boolean} switchOn 假定的开关状态。判断「能不能开启」时必须传 true，
   *   否则 readAutoAdvanceState 读到 autoAdvance=false 只会返回 'off'，
   *   真正的问题（busy / pending-roll / ended）全被掩盖。
   */
  function blockerWith(switchOn) {
    const st = getState();
    const snap = readAutoAdvanceState(st, {
      busy: isBusy(),
      pendingRoll: hasPendingRoll()
    });
    snap.autoAdvance = !!switchOn;
    return autoAdvanceBlocker(snap);
  }

  /** 按真实开关状态算阻止原因 */
  function blocker() {
    return blockerWith(!!getState()?.autoAdvance);
  }

  function cancel() {
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  /**
   * 停止自动推进。
   * @param {null|string} reason 停止原因；只有终局原因才值得给玩家留一条消息
   */
  function stop(reason) {
    const st = getState();
    if (st) st.autoAdvance = false;
    cancel();
    onChange();
    if (isTerminalBlocker(reason)) {
      const why = blockerMessage(reason, AUTO_ADVANCE_MAX_TURNS);
      if (why) notify(`【自动推进已停止】${why}。`);
    }
  }

  /**
   * 清零「连续自动推进」计数。
   *
   * 玩家手动推进、手动开关、掷完骰都算「有人在操作」，说明不是在空转，
   * 计数就该重来。这样 max-turns 只会拦真正失控的情况（没人管、模型
   * 一直输出「无事发生」），而不是把正常的长局也拦下来。
   */
  function resetRunCount() {
    const st = getState();
    if (st) st.autoAdvanceRun = 0;
  }

  /**
   * 安排下一次自动推进。
   * 已经在跑或已关闭时是安全的空操作（内部会先 cancel 旧定时器）。
   */
  function schedule() {
    cancel();

    const b = blocker();
    if (b) {
      // busy / pending-roll / max-turns 都是**暂时**状态：等请求跑完、骰子掷完、
      // 玩家手动推一次，resume() 或 resetRunCount() 会重新接上，这里不能关开关。
      // 只有 ended 是终局，才真正停止。
      if (isTerminalBlocker(b)) stop(b);
      return;
    }

    const delay = clampDelay(getState()?.autoAdvanceDelay);
    timerId = setTimer(() => {
      void fire();
    }, delay);
  }

  /** 定时器到点：再核一次状态，能推就推一轮 */
  async function fire() {
    timerId = null;

    const b = blocker();
    if (b) {
      // 定时器排队期间状态变了（玩家关了开关 / 剧情结束 / 冒出待掷骰）
      if (isTerminalBlocker(b)) stop(b);
      else if (b === 'max-turns') {
        // 连续推进到上限：停下并说明，但**不关开关**。
        // 玩家手动推一次就会清零计数、自动继续（见 resetRunCount 的说明）。
        notify(`【自动推进已暂停】连续推进达到 ${AUTO_ADVANCE_MAX_TURNS} 轮，`
          + '手动推一次即可继续。');
      }
      return;
    }
    // 上一轮还没跑完（理论上 blocker 已挡住，这里再兜一层）
    if (running) return;

    running = true;
    // 记一笔「这一轮是自动推的」，用于连续计数
    const st = getState();
    if (st) st.autoAdvanceRun = (Number(st.autoAdvanceRun) || 0) + 1;

    try {
      await runTurn();
    } catch {
      // runTurn 自己负责把错误转成消息并决定是否 stop，这里只保证
      // running 标记一定会复位，不然一次异常会让自动推进永久卡死。
    } finally {
      running = false;
    }

    // 跑完一轮后接上下一轮。
    // 用 resume() 而不是 schedule()：resume 是幂等的，
    // 如果 runTurn 内部（每轮结束处）已经排好了定时器，这里不会重置倒计时。
    if (getState()?.autoAdvance) resume();
  }

  /**
   * 若开关开着、且局面允许推进，就接上定时器。
   *
   * 这是**唯一的调度入口**——手动推进、自动推进、掷完骰之后都收敛到这里。
   * 原来手动推进只 cancel 不 resume，定时器就再也回不来了。
   */
  function resume() {
    const st = getState();
    if (!st?.autoAdvance) return;
    if (timerId !== null) return;      // 已经在计时，别重置倒计时
    if (running) return;               // 正在跑，跑完自己会 resume
    if (blocker() !== null) return;    // busy / pending-roll / ended
    schedule();
  }

  /** 切换开关 */
  function toggle() {
    const st = getState();
    if (!st || st.mode !== 'spectator') return;

    if (st.autoAdvance) {
      stop(null);
      return;
    }

    // 玩家主动开开关 = 明确想继续，连续计数清零。
    // 必须在算 blocker 之前清，否则 max-turns 会一直挡着开不了。
    resetRunCount();

    // 用「假定开关已开」算障碍，才能看出 busy / pending-roll / ended
    const b = blockerWith(true);

    // 只有终局（剧情结束）才拒绝开启：开了也永远不会动，不如直接说明原因。
    // max-turns 不在此列——它已经被 resetRunCount 清掉了，而且本身可恢复。
    if (isTerminalBlocker(b)) {
      const why = blockerMessage(b, AUTO_ADVANCE_MAX_TURNS);
      if (why) notify(`【无法自动推进】${why}。`);
      return;
    }

    // busy / pending-roll 只是暂时状态：照样把开关打开。
    // 等这一轮跑完、骰子掷完，resume() 会自动接上。
    st.autoAdvance = true;
    onChange();

    if (b === 'pending-roll') {
      // 明确告诉玩家在等什么，否则会以为开关没生效
      notify('【自动推进已就绪】有检定等你掷骰，掷完会自动继续。');
      return;
    }

    // busy 时排了也会被 blocker 挡回，交给这一轮结束时的 resume；
    // 不 busy 就立刻开始计时。
    schedule();
  }

  return {
    toggle,
    schedule,
    cancel,
    stop,
    resume,
    /** 手动推进一次：清零连续计数，让 max-turns 之后也能继续 */
    resetRunCount,
    /** 是否有排程中的定时器（测试用） */
    isTimerPending: () => timerId !== null,
    /** 是否正在跑一轮（测试用） */
    isRunning: () => running
  };
}
