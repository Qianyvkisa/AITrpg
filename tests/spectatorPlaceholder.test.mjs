// ---------------------------------------------------------------------------
// 自动推进占位语不显示在界面上
//
// 修的 bug：旁观模式下不输入内容直接点「推进」，程序会用一句
// 「（继续推进剧情，让调查员们继续行动）」冒充玩家发言。这句话被当作
// role='user' 的消息推进消息流，于是界面上出现一条玩家"说"的、但玩家
// 从没打过的话——每次推进都来一遍，很出戏。
//
// 修法：给这条消息打 hidden 标记——**不显示在界面上**，但仍然留在
// 上下文里喂给 AI（否则 AI 不知道这轮要往下推进）。同时不写进
// scenario.events（那个会进系统提示词，堆满无信息量的条目）。
//
// 直接 node tests/spectatorPlaceholder.test.mjs
// ---------------------------------------------------------------------------

import { GameEngine } from '../src/core/engine.js';
import { createInitialState } from '../src/state.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/** 造一个最小可用的 state：旁观模式，无玩家角色 */
function makeState() {
  const s = createInitialState();
  s.mode = 'spectator';
  s.playerChar = null;
  s.apiConfig = { baseUrl: 'http://x', apiKey: 'k', model: 'm' };
  s.module = { raw: '测试模组' };
  s.scenario = s.scenario || {};
  s.scenario.events = [];
  return s;
}

/**
 * 假 API：立刻返回一段 KP 回复，并回放几个 chunk。
 * 记录收到的 messages，用来验证占位语确实喂给了 AI。
 */
function makeApi(sink) {
  return {
    onChunk(fn) { this._cb = fn; return () => { this._cb = null; }; },
    async chat(req) {
      sink.push(req.messages);
      this._cb?.({ requestId: req.requestId, delta: '雨还在下。' });
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    }
  };
}

const PLACEHOLDER = '（继续推进剧情，让调查员们继续行动）';

// ---------------------------------------------------------------------------
console.log('\n== 默认推进语：不显示，但要进上下文 ==');

{
  const s = makeState();
  const seen = [];
  const engine = new GameEngine(s, makeApi(seen));

  // 模拟 spectatorAdvance 的调用方式：程序补的占位语 → hidden
  await engine.takeTurn(PLACEHOLDER, { hidden: true });

  // 1) 消息确实进了 state.messages（进上下文的前提）
  const userMsgs = s.messages.filter((m) => m.role === 'user');
  eq(userMsgs.length, 1, '占位语仍然作为 user 消息存进历史');
  eq(userMsgs[0].text, PLACEHOLDER, '存的是原文');
  ok(userMsgs[0].hidden === true, '这条消息带 hidden 标记（界面不渲染）');

  // 2) 也确实喂给了 AI
  const sent = seen[0] || [];
  const fed = sent.filter((m) => m.role === 'user' && String(m.content).includes('继续推进剧情'));
  ok(fed.length >= 1, '占位语仍然喂给 AI（AI 要知道这轮该往下推）');
}

// ---------------------------------------------------------------------------
console.log('\n== 玩家自己打了字：正常显示 ==');

{
  const s = makeState();
  const seen = [];
  const engine = new GameEngine(s, makeApi(seen));

  await engine.takeTurn('我去看看那扇门', { hidden: false });

  const userMsgs = s.messages.filter((m) => m.role === 'user');
  eq(userMsgs.length, 1, '玩家发言入历史');
  ok(!userMsgs[0].hidden, '玩家真说的话**不**带 hidden（要显示出来）');
}

// ---------------------------------------------------------------------------
console.log('\n== 不传 opts 时行为不变（向后兼容）==');

{
  const s = makeState();
  const engine = new GameEngine(s, makeApi([]));

  await engine.takeTurn('正常行动');

  const userMsgs = s.messages.filter((m) => m.role === 'user');
  ok(!userMsgs[0].hidden, '老调用方式（不传 opts）仍然正常显示');
}

// ---------------------------------------------------------------------------
console.log('\n== 占位语不写进 scenario.events ==');

{
  const s = makeState();
  const engine = new GameEngine(s, makeApi([]));

  await engine.takeTurn(PLACEHOLDER, { hidden: true });

  const noise = (s.scenario.events || []).filter((e) => String(e).includes('继续推进剧情'));
  eq(noise.length, 0, '占位语不进场景事件（否则会堆满系统提示词）');
}

// ---------------------------------------------------------------------------
console.log('\n== 玩家真行动仍写进 scenario.events ==');

{
  const s = makeState();
  const engine = new GameEngine(s, makeApi([]));

  await engine.takeTurn('我推开地下室的门');

  const hits = (s.scenario.events || []).filter((e) => String(e).includes('推开地下室'));
  ok(hits.length >= 1, '玩家真实行动仍然记入场景事件');
}

// ---------------------------------------------------------------------------
console.log('\n== 空文本不产生任何消息 ==');

{
  const s = makeState();
  const engine = new GameEngine(s, makeApi([]));

  const before = s.messages.length;
  await engine.takeTurn('   ', { hidden: true });

  eq(s.messages.length, before, '空白输入不 push 消息');
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
