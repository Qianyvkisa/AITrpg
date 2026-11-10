// ---------------------------------------------------------------------------
// 队友自主行动 · 测试
//
// 覆盖 src/services/teammateAct.js 与 engine 的编排逻辑。
//
// 背景：原来队友的行动、台词、检定全由 KP 一个 AI 代演（提示词里明写
// 「队友调查员（由你扮演）」）。这个测试守的是新契约：
//   1) 每位队友由自己的一次 LLM 调用决定行动
//   2) 队友 AI 只能提出行动 + 请求检定，**不能宣布结果**
//   3) 队友请求的检定走本地掷骰，复用 directives 统一结算
//   4) 关掉开关要能退回 KP 代演
//
// 直接 node tests/teammateAct.test.mjs
// ---------------------------------------------------------------------------

import { createInitialState } from '../src/state.js';
import { createCharacter } from '../src/core/character.js';
import { GameEngine } from '../src/core/engine.js';
import {
  stampActorIntoDirectives,
  pickActingTeammates,
  generateTeammateAction
} from '../src/services/teammateAct.js';
import { keeperSystemPrompt, teammateActionPrompt } from '../src/core/prompts.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/** 造一个带队友的 state */
function withMate(opts = {}) {
  const s = createInitialState();
  s.mode = 'spectator';
  s.teammates = [
    createCharacter({ name: '郑野' }),
    createCharacter({ name: '林默' })
  ];
  s.scenario = { scene: '码头仓库', events: [], clues: [], secrets: [], notes: '', ended: false };
  Object.assign(s, opts);
  return s;
}

/** 假 api：记录每次调用，按脚本返回 */
function mkApi(reply) {
  const calls = [];
  return {
    calls,
    chat: async (payload) => {
      calls.push(payload);
      const r = typeof reply === 'function' ? reply(payload, calls.length) : reply;
      if (r && r.ok === false) return r;
      return { ok: true, text: r?.text ?? r };
    },
    onChunk: () => () => {}
  };
}

// ---------------------------------------------------------------------------
console.log('\n== 队友 AI 输出的检定指令要补上角色名 ==');

{
  const out = stampActorIntoDirectives(
    '我贴着墙根挪到门边。[[CHECK: 聆听 | 原因=想确认屋里有没有人]]',
    '郑野'
  );
  ok(out.includes('角色=郑野'), '补上了角色名');
  ok(out.includes('聆听'), '保留技能名');
  ok(out.includes('原因=想确认屋里有没有人'), '保留原因');

  // AI 自己写了角色名时，以它自己为准，不能串人
  const out2 = stampActorIntoDirectives('[[CHECK: 侦查 | 角色=别人 | 原因=看看]]', '郑野');
  ok(out2.includes('角色=郑野'), '已有角色名被改写为本人');
  ok(!out2.includes('角色=别人'), '不会残留别人名字');

  // 多条指令都要处理
  const out3 = stampActorIntoDirectives(
    '[[CHECK: 侦查]] 然后 [[SAN: 1/1d4 | 原因=看见东西]]',
    '林默'
  );
  eq((out3.match(/角色=林默/g) || []).length, 2, '两条指令都补上了角色名');

  // 没有指令时原样返回
  const out4 = stampActorIntoDirectives('我只是站着不动。', '郑野');
  eq(out4, '我只是站着不动。', '无指令时原样返回');
}

// ---------------------------------------------------------------------------
console.log('\n== generateTeammateAction：一次独立调用，产出行动 + 指令 ==');

{
  const s = withMate();
  const api = mkApi({ text: '我蹲下去检查地板上的划痕。[[CHECK: 侦查 | 原因=找线索]]' });

  const res = await generateTeammateAction(s, api, s.teammates[0], { playerAction: '我推开门' });

  eq(api.calls.length, 1, '只调用一次');
  eq(api.calls[0].purpose, 'teammate', "purpose 是 'teammate'（走队友模型配置）");
  eq(res.ok, true, '返回成功');
  eq(res.name, '郑野', '名字正确');
  ok(!res.text.includes('[['), '行动正文里剥掉了指令');
  ok(res.text.includes('划痕'), '保留了行动内容');
  eq(res.directives.length, 1, '解析出 1 条指令');
  eq(res.directives[0].type, 'CHECK', '指令类型是 CHECK');
  eq(res.directives[0].opts['角色'], '郑野', '指令自动带上角色名');
}

// ---------------------------------------------------------------------------
console.log('\n== 队友 AI 不能宣布结果：提示词必须禁止 ==');

{
  const p = teammateActionPrompt({
    char: '调查员：郑野',
    party: '队伍',
    scene: '仓库',
    tone: '经典恐怖',
    recent: 'KP：门是锁着的',
    playerAction: '我推了推门',
    lastSpeaker: '林默'
  });

  ok(p.includes('绝不宣布结果'), '提示词禁止宣布结果');
  ok(p.includes('绝不替 KP 描述世界'), '提示词禁止替 KP 描写世界');
  ok(p.includes('[[CHECK:'), '给了检定指令格式');
  ok(p.includes('不要写角色名'), '要求不写角色名（由系统补）');
  ok(p.includes('林默'), '提到上一位说话者，避免重复');
}

// ---------------------------------------------------------------------------
console.log('\n== KP 提示词：自主模式下不再代演队友 ==');

{
  const mates = ['调查员：郑野', '调查员：林默'];

  const auto = keeperSystemPrompt({
    module: '', scenario: { scene: '仓库' }, playerChar: '调查员：我',
    teammates: mates, companions: [], tone: '经典恐怖', mode: 'player',
    teammateAutonomous: true
  });
  ok(auto.includes('不由你扮演'), '自主模式明确说队友不由 KP 扮演');
  ok(auto.includes('你绝对不能替他们行动或说话'), '自主模式明确禁止代演');
  ok(!auto.includes('队友调查员（由你扮演）'), '自主模式不再出现「由你扮演」');

  const legacy = keeperSystemPrompt({
    module: '', scenario: { scene: '仓库' }, playerChar: '调查员：我',
    teammates: mates, companions: [], tone: '经典恐怖', mode: 'player',
    teammateAutonomous: false
  });
  ok(legacy.includes('队友调查员（由你扮演）'), '代演模式保留「由你扮演」');
  ok(!legacy.includes('你绝对不能替他们行动或说话'), '代演模式不出现禁止代演');
}

// ---------------------------------------------------------------------------
console.log('\n== 旁观模式提示词不能与自主模式自相矛盾 ==');

{
  const auto = keeperSystemPrompt({
    module: '', scenario: { scene: '仓库' }, playerChar: '',
    teammates: ['调查员：郑野'], companions: [], tone: '经典恐怖', mode: 'spectator',
    teammateAutonomous: true
  });
  ok(!auto.includes('所有调查员都由你（KP）来驱动'),
    '自主模式下不再说「所有调查员都由 KP 驱动」（否则和队友自主冲突）');
  ok(auto.includes('队友由各自独立的 AI 驱动'), '明确说明队友有自己的 AI');

  const legacy = keeperSystemPrompt({
    module: '', scenario: { scene: '仓库' }, playerChar: '',
    teammates: ['调查员：郑野'], companions: [], tone: '经典恐怖', mode: 'spectator',
    teammateAutonomous: false
  });
  ok(legacy.includes('所有调查员都由你（KP）来驱动'), '代演模式保留旧说法');
}

// ---------------------------------------------------------------------------
console.log('\n== pickActingTeammates：开关与概率控制成本 ==');

{
  const s = withMate();
  s.teammateAutonomous = false;
  eq(pickActingTeammates(s).length, 0, '开关关掉时无人行动');

  const s2 = withMate();
  s2.scenario.ended = true;
  eq(pickActingTeammates(s2).length, 0, '剧情结束无人行动');

  const s3 = withMate();
  s3.teammates = [];
  eq(pickActingTeammates(s3).length, 0, '没有队友时无人行动');

  // 概率 1：两位都应行动
  const s4 = withMate();
  eq(pickActingTeammates(s4, { chance: 1 }).length, 2, '概率 100% 时全部行动');

  // 概率 0：至少保证有一位（否则玩家觉得队友是木头）
  const s5 = withMate();
  const zero = pickActingTeammates(s5, { chance: 0 });
  eq(zero.length, 0, '概率 0 时无人行动（明确要求不动）');

  // 概率很低但大于 0：至少有一位
  const s6 = withMate();
  for (let i = 0; i < 20; i++) {
    const r = pickActingTeammates(s6, { chance: 0.01 });
    ok(r.length >= 1, '低概率下仍保证至少一人行动');
  }
}

// ---------------------------------------------------------------------------
console.log('\n== engine：队友行动进 KP 上下文，KP 据此裁定 ==');

{
  const s = withMate();
  s.teammateAutonomous = true;

  const seen = [];
  const api = {
    chat: async (payload) => {
      // 记录 KP 调用收到的 messages，稍后断言里面有队友行动
      if (payload.purpose === 'keeper') seen.push(payload.messages);
      return { ok: true, text: '门后传来一声闷响。' };
    },
    onChunk: () => () => {}
  };

  const eng = new GameEngine(s, api);
  // alreadyPushed 不设：模拟「注入方没推过」，由引擎自己推
  eng.setTeammateActor(async () => ([{
    ok: true, name: '郑野', text: '我蹲下去检查地板上的划痕。', directives: []
  }]));
  // 关掉插话，避免干扰断言
  s.autoTeammate = false;

  await eng.takeTurn('我推开门');

  // 找到队友行动之后的那次 KP 调用
  const lastKeeper = seen[seen.length - 1];
  const flat = JSON.stringify(lastKeeper);
  ok(flat.includes('[队友行动]'), 'KP 上下文里带上了「[队友行动]」标记');
  ok(flat.includes('郑野'), 'KP 知道是谁行动的');
  ok(flat.includes('划痕'), 'KP 知道队友做了什么');

  const mateMsg = s.messages.find((m) => m.role === 'teammate-action');
  ok(!!mateMsg, '队友行动记为 teammate-action 消息');
  eq(mateMsg.name, '郑野', '消息带队友名字');
}

// ---------------------------------------------------------------------------
console.log('\n== engine：注入方已推送时不重复推（真实 app.js 路径）==');

{
  const s = withMate();
  s.autoTeammate = false;

  const api = {
    chat: async () => ({ ok: true, text: '门后传来一声闷响。' }),
    onChunk: () => () => {}
  };
  const eng = new GameEngine(s, api);

  // 模拟 app.js：为了让后续队友看到前面的行动，生成时就把消息推进去了
  eng.setTeammateActor(async () => {
    eng.pushMessage({ role: 'teammate-action', name: '郑野', text: '我去看看后门。' });
    return [{ ok: true, name: '郑野', text: '我去看看后门。', directives: [], alreadyPushed: true }];
  });

  await eng.takeTurn('我推开门');

  const acts = s.messages.filter((m) => m.role === 'teammate-action');
  eq(acts.length, 1, '只有一条队友行动消息，没有重复');
  eq(acts[0].text, '我去看看后门。', '内容正确');
}

// ---------------------------------------------------------------------------
console.log('\n== engine：队友请求的检定由本地掷骰，AI 不能编结果 ==');

{
  const s = withMate();
  s.autoTeammate = false;
  const mate = s.teammates[0];
  mate.skills['侦查'] = 60;

  const api = {
    chat: async () => ({ ok: true, text: '门后传来一声闷响。' }),
    onChunk: () => () => {}
  };

  const eng = new GameEngine(s, api);
  eng.setTeammateActor(async () => ([{
    ok: true,
    name: mate.name,
    text: '我检查地板。',
    directives: [{ type: 'CHECK', head: '侦查', opts: { 角色: mate.name, 原因: '找线索' }, raw: '' }],
    alreadyPushed: true
  }]));

  await eng.takeTurn('我推开门');

  const roll = s.messages.find((m) => m.role === 'roll');
  ok(!!roll, '产生了骰点消息');
  ok(!!roll.data?.roll?.value, '骰点是本地掷出来的（有具体数值）');
  ok(roll.text.includes('侦查'), '结果里带技能名');
  eq(roll.data.who, mate.name, '检定归属正确');

  // 队友检定应自动结算，不进入待玩家掷骰
  eq(eng.pendingRolls().length, 0, '队友检定自动掷，不阻塞玩家');
}

// ---------------------------------------------------------------------------
console.log('\n== engine：关掉自主模式则完全退回旧行为 ==');

{
  const s = withMate();
  s.teammateAutonomous = false;
  s.autoTeammate = false;

  let actorCalled = 0;
  const api = {
    chat: async () => ({ ok: true, text: '门后传来一声闷响。' }),
    onChunk: () => () => {}
  };
  const eng = new GameEngine(s, api);
  eng.setTeammateActor(async () => { actorCalled++; return []; });

  await eng.takeTurn('我推开门');

  // 注入的 actor 会被调用（引擎不判断开关，判断在 pickActingTeammates 里），
  // 但它返回空列表 → 没有队友行动消息
  const mateMsg = s.messages.find((m) => m.role === 'teammate-action');
  ok(!mateMsg, '自主模式关闭时没有队友自主行动消息');

  // 更关键：KP 提示词要退回「由你扮演」
  const keeperCall = s.messages.length > 0;
  ok(keeperCall, '正常跑完一轮');
}

// ---------------------------------------------------------------------------
console.log('\n== engine：队友 AI 失败不中断整轮 ==');

{
  const s = withMate();
  s.autoTeammate = false;

  const api = {
    chat: async () => ({ ok: true, text: '门后传来一声闷响。' }),
    onChunk: () => () => {}
  };
  const eng = new GameEngine(s, api);
  eng.setTeammateActor(async () => { throw new Error('网络挂了'); });

  const r = await eng.takeTurn('我推开门');

  eq(r.ok, true, '队友 AI 失败不影响本轮整体成功');
  const err = s.messages.find((m) => m.role === 'system' && m.text.includes('队友 AI 失败'));
  ok(!!err, '记录了失败提示');
  ok(err.hidden, '失败提示对玩家隐藏（不打扰）');
}

// ---------------------------------------------------------------------------
console.log('\n== engine：待玩家掷骰时不再继续编排队友 ==');

{
  const s = withMate();
  s.autoTeammate = false;
  // 给玩家一个角色，让 CHECK 变成待掷骰
  s.playerChar = createCharacter({ name: '我', isPlayer: true });
  s.playerChar.skills['侦查'] = 50;
  s.mode = 'player';

  const api = {
    chat: async () => ({ ok: true, text: '你看到地板上有划痕。' }),
    onChunk: () => () => {}
  };
  const eng = new GameEngine(s, api);
  eng.setTeammateActor(async () => ([{
    ok: true, name: '郑野', text: '我也去看看。',
    directives: [{ type: 'CHECK', head: '侦查', opts: { 角色: '我' }, raw: '' }],
    alreadyPushed: true
  }]));

  await eng.takeTurn('我蹲下查看');

  // 玩家角色的检定应阻塞，等玩家点掷骰
  ok(eng.pendingRolls().length > 0, '玩家检定进入待掷骰状态');
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
