import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createCharacter } from '../src/core/character.js';
import { getHandler, resolveSkillValue } from '../src/core/directives.js';
import { rollDice, rollD100 } from '../src/core/dice.js';
import { applyDamage, incapacity, recoverHp } from '../src/core/vitals.js';
import { GameEngine } from '../src/core/engine.js';
import { createInitialState } from '../src/state.js';
import { applySnapshot, buildSnapshot, turnCount } from '../src/persistence.js';
import { hasRunTurn, menuButtonVisibility } from '../src/ui/menu.js';
import { generateTeammateAction, pickActingTeammates } from '../src/services/teammateAct.js';
import { applyRoomState, mergeRoomMessages, publicMessage, publicRoomState, rollOwner, roomHistory } from '../src/core/onlineSession.js';
import { BUILTIN_MODULES, openingFor } from '../src/core/builtinModules.js';
import { openingSceneFor, readModuleGuide } from '../src/core/moduleGuide.js';

function fixedDice(digits, run) {
  const oldRandom = Math.random;
  Math.random = () => {
    assert.ok(digits.length, 'unexpected dice roll');
    return digits.shift();
  };
  try { return run(); } finally { Math.random = oldRandom; }
}

function createEngine(state, respond) {
  return new GameEngine(state, { onChunk: () => () => {}, chat: respond });
}

const storedSnapshot = (state) => JSON.parse(JSON.stringify(buildSnapshot(state)));

test('旁观开场使用实际名单，并修正旧档中写死的三位调查员', () => {
  const [module] = BUILTIN_MODULES;
  const whiteHeron = createCharacter({ name: '白鹭' });
  const guide = createCharacter({ name: '周砚' });
  const old = '深夜，三位调查员在朋友的旧宅里整理遗物。窗外雨声绵密，灯忽明忽暗。';
  const messages = [
    { id: 'welcome', role: 'keeper', text: old, clean: old },
    { id: 'later', role: 'keeper', text: '书房里另一个人翻开账本。' }
  ];
  const state = createInitialState();
  applySnapshot(state, {
    mode: 'spectator', module: { ...module, openingSpectator: old },
    teammates: [whiteHeron], messages, scenario: { scene: module.scene }
  });
  assert.match(state.messages[0].text, /白鹭在朋友的旧宅里整理遗物/);
  assert.doesNotMatch(state.messages[0].text, /三位|走在最后/);
  assert.equal(state.messages[0].text, state.messages[0].clean);
  assert.equal(state.messages[1].text, messages[1].text);
  assert.match(openingFor(module, 'spectator', [whiteHeron, guide]), /白鹭、周砚在/);
  assert.match(openingFor(null, 'spectator', [whiteHeron]), /白鹭刚刚坐下/);
  assert.equal(openingFor(module, 'player', [whiteHeron]), module.opening);
});

test('人物档案只接纳定稿，按场景与称呼更新，并分开玩家视图和守密人笔记', async () => {
  const state = createInitialState();
  state.mode = 'spectator';
  state.module = { raw: '场景流程：书房 → 门厅' };
  state.scenario.scene = '书房';
  state.teammates = [createCharacter({ name: '白鹭' })];
  state.companions = [createCharacter({ name: '周砚' })];
  const prompts = [];
  const replies = [
    '越过门厅。[[NPC: 不应入档的人 | 状态=在场]][[SCENE: 阁楼]]',
    '书房翻账本的人合上了本子。[[NPC: 书房翻账本的人 | 状态=在场 | 公开=正在翻账本]]' +
      '[[NPC: 藏在暗处的人 | 状态=未登场 | 守密人=可能会来收账]]' +
      '[[SAY: 白鹭 | 等一下。]][[SAY: 周砚 | 我在这里。]]',
    '翻账本的人把钥匙放下。[[SAY: 书房翻账本的人 | 我叫玛莎。]]' +
      '[[NPC: 玛莎 | 原称=书房翻账本的人 | 身份=旧宅管家 | 状态=离场 | 公开=留下了一把钥匙 | 守密人=心里仍有戒备]]' +
      '[[SCENE: 门厅]][[SAY: 门房 | 您来了。]]'
  ];
  const engine = createEngine(state, async ({ messages }) => {
    prompts.push(messages[0].content);
    return { ok: true, text: replies.shift() };
  });
  assert.equal(await engine.runKeeper(), true);
  assert.equal(await engine.runKeeper(), true);
  assert.match(prompts[0], /队伍共 1 人（含联机调查员）：白鹭/);
  assert.doesNotMatch(prompts[2], /不应入档的人/);
  assert.match(prompts[2], /书房翻账本的人/);
  assert.match(prompts[2], /可能会来收账/);
  assert.deepEqual(state.scenario.npcs.map((npc) => npc.name), ['门房', '玛莎', '藏在暗处的人']);
  const [doorman, martha] = state.scenario.npcs;
  assert.equal(doorman.scene, '门厅');
  assert.equal(martha.scene, '书房');
  assert.equal(martha.status, '离场');
  assert.equal(martha.lastLine, '我叫玛莎。');
  assert.deepEqual(martha.aliases, ['书房翻账本的人']);

  const restored = createInitialState();
  applySnapshot(restored, storedSnapshot(state));
  assert.deepEqual(restored.scenario.npcs, state.scenario.npcs);
  const payload = publicRoomState(restored, { ready: true, busy: false });
  assert.deepEqual(payload.scenario.npcs.map((npc) => npc.name), ['门房', '玛莎']);
  assert.equal(payload.scenario.npcs[1].publicNote, '留下了一把钥匙');
  assert.doesNotMatch(JSON.stringify(payload), /藏在暗处的人|可能会来收账|仍有戒备/);
  assert.doesNotMatch(JSON.stringify(publicMessage(state, state.messages.at(-1))), /守密人=|仍有戒备/);
  const guest = createInitialState();
  applyRoomState(guest, payload);
  assert.deepEqual(guest.scenario.npcs, payload.scenario.npcs);
});

test('旧档从明确的 NPC 台词恢复人物，忽略含糊旁白和调查员的台词', () => {
  const state = createInitialState();
  applySnapshot(state, {
    teammates: [createCharacter({ name: '白鹭' })],
    scenario: { scene: '旧宅书房' },
    messages: [
      { role: 'keeper', text: '书房里另一个人翻开账本。' },
      { role: 'keeper', text: '[[SAY: 白鹭 | 怎么回事？]][[SAY: NPC·管家 | 别开门。]]' },
      { role: 'scene', text: '【场景】门厅' },
      { role: 'keeper', segments: [{ kind: 'say', name: '门房', text: '请往这边走。' }] }
    ]
  });
  assert.deepEqual(state.scenario.npcs.map(({ name, scene }) => [name, scene]),
    [['门房', '门厅'], ['管家', '旧宅书房']]);
});

test('停止等待后拒绝迟到的守密人回复，继续使用原行动', async () => {
  const state = createInitialState();
  state.module = { raw: '场景流程：书房 → 门厅' };
  state.scenario.scene = '书房';
  let finish;
  let canceled;
  const engine = new GameEngine(state, {
    onChunk: () => () => {},
    chat: () => new Promise(resolve => { finish = resolve; }),
    cancel: id => { canceled = id; }
  });
  const phases = [];
  engine.on(event => { if (event.type === 'narration-status') phases.push(event.label); });
  const pending = engine.takeTurn('推开门');
  await engine.cancelNarration();
  finish({ ok: true, text: '迟到的回复。[[SCENE:门厅]]' });
  assert.equal((await pending).ok, false);
  assert.equal(canceled, 1);
  assert.equal(state.turns, 0);
  assert.equal(state.scenario.scene, '书房');
  assert.ok(state.keeperContinuation.retryAction);
  assert.deepEqual(phases, ['等待守密人响应', '正在停止', '']);
  engine.api.chat = async () => ({ ok: true, text: '你来到门厅。[[SCENE:门厅]]' });
  assert.equal((await engine.takeTurn('')).ok, true);
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(state.scenario.scene, '门厅');
});

test('奇数最大 HP 的重伤门槛、累计小伤昏迷、濒死和即死分别结算', () => {
  const ch = createCharacter({ name: '林默' });
  ch.hp = { max: 11, current: 11 };
  assert.equal(applyDamage(ch, 5).majorWound, false);
  assert.equal(applyDamage(ch, 5).majorWound, false);
  assert.equal(applyDamage(ch, 1).outcome, '昏迷');
  assert.equal(incapacity(ch), '昏迷');
  assert.equal(recoverHp(ch, 1), 1);
  assert.equal(incapacity(ch), '');
  assert.equal(applyDamage(ch, 6).outcome, '濒死');
  assert.equal(incapacity(ch), '濒死');
  assert.equal(recoverHp(ch, 1), 1);
  assert.equal(incapacity(ch), '');
  assert.ok(ch.status.includes('重伤'));
  assert.equal(applyDamage(ch, 11).outcome, '死亡');
  assert.equal(recoverHp(ch, 5), 0);
  assert.equal(incapacity(ch), '死亡');
  assert.equal(ch.hp.current, 0);
});

test('唯一旁观调查员 HP 归零时结团并停用自动续写与队友动作', async () => {
  const state = createInitialState();
  state.mode = 'spectator';
  const actor = createCharacter({ name: '向导' });
  actor.hp.current = 2;
  state.teammates = [actor];
  let calls = 0;
  const engine = createEngine(state, async () => {
    calls++;
    return { ok: true, text: '石门压下来。[[HP:-2]]' };
  });
  engine.setTeammateActor(() => assert.fail('终局后不可调用队友模型'));
  assert.equal((await engine.takeTurn('推进', { hidden: true })).ok, true);
  assert.equal(actor.hp.current, 0);
  assert.equal(incapacity(actor), '昏迷');
  assert.equal(state.scenario.ended, true);
  assert.match(state.scenario.ending, /向导.*昏迷/);
  assert.equal(state.keeperContinuation, null);
  assert.equal((await engine.takeTurn('再推进', { hidden: true })).ok, false);
  assert.equal(calls, 1);
  assert.equal(turnCount(state), 1);
  assert.equal(hasRunTurn(storedSnapshot(state)), true);
  assert.deepEqual(menuButtonVisibility(true, true), { start: true, cont: true, abandon: true });
});

test('有幸存者时，倒下的调查员不能代发行动，同伴救援后可以恢复', async () => {
  const state = createInitialState();
  const pc = state.playerChar = createCharacter({ name: '房主', isPlayer: true });
  pc.hp.current = 0;
  const ally = createCharacter({ name: '医师' });
  state.teammates = [ally];
  const engine = createEngine(state, async ({ messages }) => {
    assert.match(messages[0].content, /旁观/);
    return { ok: true, text: '医师伸手援助。[[HP:+1|角色=房主]]' };
  });
  assert.equal((await engine.takeTurn('冲出去', { actorId: pc.id })).ok, false);
  assert.equal((await engine.takeTurn('推进同伴', { hidden: true })).ok, true);
  assert.equal(pc.hp.current, 1);
  assert.equal(incapacity(pc), '');
  assert.equal(state.scenario.ended, false);
});

test('已有普通待掷骰的调查员受伤倒下时，取消骰子并将结算回喂', async () => {
  const state = createInitialState();
  const pc = state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  pc.hp.current = 2;
  state.teammates = [createCharacter({ name: '向导' })];
  const engine = createEngine(state, () => assert.fail('直接结算不应发起叙事'));
  await engine.resolveDirectives([
    { type: 'CHECK', head: '侦查', opts: {} },
    { type: 'DAMAGE', head: '2', opts: {} }
  ]);
  assert.equal(engine.pendingRolls().length, 0);
  assert.equal(state.messages.find((m) => m.data?.kind === 'check').data.status, 'cancelled');
  assert.match(state.messages.at(-1).text, /检定取消/);
  assert.equal(state.scenario.ended, false);
  assert.equal(state.rollBatch, null);
});

test('重伤应先让玩家掷实际体质，失败会取消其余普通检定', async () => {
  const state = createInitialState();
  const pc = state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  pc.attrs.CON = 55;
  const engine = createEngine(state, () => assert.fail('全员倒下后不再续写'));
  await engine.resolveDirectives([
    { type: 'DAMAGE', head: '5', opts: {} },
    { type: 'CHECK', head: '侦查', opts: {} }
  ]);
  const [con, skill] = engine.pendingRolls();
  assert.equal(con.skill, '体质');
  assert.equal(con.adjusted, 55);
  assert.equal(await engine.rollAndResume(skill.id), null);
  const original = Math.random;
  try {
    Math.random = () => 0.9;
    const result = await engine.rollAndResume(con.id);
    assert.equal(result.passed, false);
  } finally {
    Math.random = original;
  }
  assert.equal(pc.hp.current, 5);
  assert.equal(incapacity(pc), '昏迷');
  assert.equal(state.scenario.ended, true);
  assert.equal(engine.pendingRolls().length, 0);
});

test('濒死体质可由仍有同伴的调查员掷出，失败记录死亡', async () => {
  const state = createInitialState();
  const pc = state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  pc.hp.current = 2;
  const ally = createCharacter({ name: '医师' });
  state.teammates = [ally];
  const engine = createEngine(state, async () => ({ ok: true, text: '医师仍在现场。' }));
  await engine.resolveDirectives([
    { type: 'DAMAGE', head: '5', opts: {} },
    { type: 'CHECK', head: '体质', opts: { 角色: pc.name, 用途: '濒死' } }
  ]);
  const [roll] = engine.pendingRolls();
  assert.equal(roll.effect, 'dying');
  assert.equal(incapacity(pc), '濒死');
  const original = Math.random;
  try {
    Math.random = () => 0.9;
    assert.match((await engine.rollAndResume(roll.id)).outcome, /死亡/);
  } finally {
    Math.random = original;
  }
  assert.equal(incapacity(pc), '死亡');
  assert.equal(state.scenario.ended, false);
});

test('END 取消已登记检定，并阻止本条回复的后续状态变更', async () => {
  const state = createInitialState();
  const pc = state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  const engine = createEngine(state, async () => ({ ok: true, text: '[[CHECK:侦查]][[END:撤离]][[HP:-10]][[SCENE:其他地方]]' }));
  assert.equal((await engine.takeTurn('撤离')).ok, true);
  assert.equal(state.scenario.ending, '撤离');
  assert.equal(pc.hp.current, pc.hp.max);
  assert.equal(engine.pendingRolls().length, 0);
  assert.equal(state.messages.find((m) => m.data?.kind === 'check').data.status, 'cancelled');
  assert.equal(state.scenario.scene, '');
});

test('旧存档结团后清理掉已失效的骰子和续写标记', () => {
  const state = createInitialState();
  const pc = state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  const engine = createEngine(state, () => assert.fail('读档修复不能调用模型'));
  getHandler('CHECK')(engine.context(), { head: '侦查', opts: {} });
  const [pending] = engine.pendingRolls();
  pc.hp.current = 0;
  state.rollBatch = [{ pendingId: pending.id }];
  state.keeperContinuation = {};

  const loaded = createInitialState();
  applySnapshot(loaded, storedSnapshot(state));
  const reload = createEngine(loaded, () => assert.fail('读档修复不能调用模型'));
  assert.equal(reload.reconcileParty(), true);
  assert.equal(reload.reconcileParty(), false);
  assert.equal(loaded.scenario.ended, true);
  assert.equal(loaded.rollBatch, null);
  assert.equal(loaded.keeperContinuation, null);
  assert.equal(loaded.messages.filter((m) => m.role === 'scene').length, 1);
  assert.equal(loaded.messages.find((m) => m.data?.id === pending.id).data.status, 'cancelled');
});

test('联机省略受伤者时结算给实际行动者，倒下后禁止该客人发送行动', async () => {
  const state = createInitialState();
  const host = state.playerChar = createCharacter({ name: '房主', isPlayer: true });
  const guest = createCharacter({ name: '客人' });
  guest.hp.current = 2;
  state.teammates = [guest];
  state.net.role = 'host';
  state.net.players = [{ id: 'p1', charId: guest.id }];
  const replies = ['[[DAMAGE:2]]', '房主扶住了客人。'];
  const engine = createEngine(state, async () => ({ ok: true, text: replies.shift() }));
  engine.rollOwner = (ch) => rollOwner(state, ch);
  assert.equal((await engine.takeTurn('调查过道', { actorId: guest.id })).ok, true);
  assert.equal(host.hp.current, host.hp.max);
  assert.equal(guest.hp.current, 0);
  assert.equal((await engine.takeTurn('继续调查', { actorId: guest.id })).ok, false);
  assert.equal(state.scenario.ended, false);
  assert.equal(publicRoomState(state, { ready: true, busy: false }).teammates[0].hp.current, 0);
});

test('已经失败的模型请求可在读档后重试同一行动一次', async () => {
  const state = createInitialState();
  state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  const first = createEngine(state, async () => ({ ok: false, error: '网络中断' }));
  assert.equal((await first.takeTurn('查看石门')).ok, false);
  assert.equal(turnCount(state), 0);

  const loaded = createInitialState();
  const saved = storedSnapshot(state);
  assert.equal(saved.meta.turns, 0);
  applySnapshot(loaded, saved);
  const retry = createEngine(loaded, async ({ messages }) => {
    assert.equal(messages.filter((m) => m.content === '查看石门').length, 1);
    return { ok: true, text: '石门上刻着一个图案。' };
  });
  assert.equal((await retry.takeTurn('')).ok, true);
  assert.equal(loaded.turns, 1);
  assert.equal(loaded.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(loaded.keeperContinuation, null);
});

test('超大骰池和不完整骰式被拒绝，属性及幸运用当前值', () => {
  assert.equal(rollDice('1000000d6').invalid, true);
  assert.equal(rollDice('2d0').invalid, true);
  assert.equal(rollDice('2d6d6').invalid, true);
  assert.equal(rollDice('2d6+').invalid, true);
  assert.equal(rollDice('2d6 - 1').invalid, undefined);
  assert.equal(rollD100({ bonus: Number.MAX_VALUE }).candidates.length, 3);
  const ch = createCharacter({ name: '林默' });
  ch.attrs.CON = 63;
  ch.luck.current = 24;
  assert.equal(resolveSkillValue(ch, '体质'), 63);
  assert.equal(resolveSkillValue(ch, 'con'), 63);
  assert.equal(resolveSkillValue(ch, '幸运'), 24);
});

test('队友 AI 无法直接改血量、场景或结局，只能请求自身检定', async () => {
  const state = createInitialState();
  const fallen = createCharacter({ name: '倒下' });
  fallen.hp.current = 0;
  const active = createCharacter({ name: '医师' });
  state.teammates = [fallen, active];
  const api = { chat: async () => ({ ok: true, text: '查看四周。[[HP:+10]][[END:结束]][[SCENE:外面]][[CHECK:侦查|角色=倒下]]' }) };
  assert.deepEqual(pickActingTeammates(state, { chance: 1 }), [active]);
  assert.equal((await generateTeammateAction(state, api, fallen)).ok, false);
  const plan = await generateTeammateAction(state, api, active);
  assert.equal(plan.directives.length, 1);
  assert.equal(plan.directives[0].type, 'CHECK');
  assert.equal(plan.directives[0].actorId, active.id);
  assert.equal(plan.directives[0].opts['角色'], active.name);
});

test('理智阈值、INT 发作和技能难度使用各自的数值', () => {
  const ch = createCharacter({ name: '林默' });
  ch.attrs.POW = 70;
  ch.attrs.INT = 60;
  ch.san.current = 25;
  ch.skills['侦查'] = 60;
  const ctx = {
    state: { playerChar: null, teammates: [ch], scenario: { events: [] } },
    findChar: () => ch,
    pushMessage() {}
  };

  const sanity = (loss) => getHandler('SAN')(ctx, { head: loss, opts: {} });
  const fail = fixedDice([0, 0.4, 0, 0.3], () => sanity('0/6'));
  assert.equal(fail.sanRoll.value, 40);
  assert.equal(fail.loss, 6);
  assert.equal(fail.boutTriggered, true);
  assert.ok(ch.status.includes('临时疯狂'));
  ch.san.current = 25;
  const fumble = fixedDice([0.6, 0.9, 0, 0.8], () => sanity('0/1d6+1'));
  assert.equal(fumble.sanRoll.value, 96);
  assert.equal(fumble.loss, 7);
  assert.equal(fumble.boutTriggered, false);

  const check = () => getHandler('CHECK')(ctx, { head: '侦查', opts: { 难度: '困难' } });
  const hard = fixedDice([0, 0.2], check);
  assert.equal(hard.level.level, 'hard');
  assert.equal(hard.passed, true);
  const regular = fixedDice([0, 0.4], check);
  assert.equal(regular.level.level, 'regular');
  assert.equal(regular.passed, false);
  assert.equal(fixedDice([0.6, 0.9], check).level.level, 'fumble');
});

test('部分掷骰读档后可继续，续写失败时保留整批结果和角色扣值', async () => {
  const state = createInitialState();
  state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  const startSan = state.playerChar.san.current;
  const engine = createEngine(state, async () => ({ ok: true, text: [
    '门缝里传来声音。', '[[CHECK:侦查]]', '[[SAN:2/2]]', '[[DAMAGE:1]]'
  ].join('\n') }));
  let saved;
  engine.checkpoint = async () => { saved = storedSnapshot(state); };
  await engine.takeTurn('调查门缝');
  const initialHP = state.playerChar.hp.current;
  const [first, second] = engine.pendingRolls();
  await engine.rollAndResume(first.id);
  assert.equal(saved.state.rollBatch[0].result.status, 'rolled');

  const loaded = createInitialState();
  applySnapshot(loaded, saved);
  const failed = createEngine(loaded, async ({ messages }) => {
    assert.ok(saved.state.keeperContinuation, '扣值完成后应先落盘');
    assert.equal(saved.state.playerChar.san.current, startSan - 2);
    const report = messages.at(-1).content;
    assert.match(report, /侦查/);
    assert.match(report, /损失 2 点 SAN/);
    assert.match(report, /受到 1 点伤害/);
    return { ok: false, error: '连接中断' };
  });
  failed.checkpoint = async () => { saved = storedSnapshot(loaded); };
  await failed.rollAndResume(second.id);
  assert.ok(loaded.keeperContinuation);
  assert.equal(loaded.playerChar.hp.current, initialHP);

  const restored = createInitialState();
  applySnapshot(restored, saved);
  const retry = createEngine(restored, async ({ messages }) => {
    assert.match(messages.at(-1).content, /侦查[\s\S]*理智检定[\s\S]*伤害/);
    return { ok: true, text: '你辨出声源来自门后的暗格。' };
  });
  assert.equal((await retry.resumeKeeper()).ok, true);
  assert.equal(restored.keeperContinuation, null);
  assert.equal(restored.playerChar.san.current, startSan - 2);
  assert.equal(restored.playerChar.hp.current, initialHP);
  assert.equal(restored.messages.filter((message) => message.role === 'system-result').length, 1);
});

test('旧线索、NPC 约定和模组后段能在读档后被当前调查找回', async () => {
  const state = createInitialState();
  state.scenario.scene = '钟楼';
  state.module = { raw: `旧港调查\n\n${'无关气象记录。'.repeat(2600)}\n\n【银鹿船票】旧港检票员认得伪造的船票。` };
  const engine = createEngine(state, async () => ({
    ok: true,
    text: '钟楼夹层是空的。[[SAY:老徐|带银鹿船票去旧港，我会等你。]][[CLUE:银鹿船票]][[SCENE:市镇]]'
  }));
  await engine.takeTurn('寻找钟楼夹层');
  for (let i = 0; i < 50; i++) {
    state.messages.push({ role: 'keeper', text: `市镇闲谈 ${i}`, clean: `市镇闲谈 ${i}` });
    state.scenario.investigation.push({ scene: '市镇', text: '市镇无关记事。'.repeat(50), clues: [] });
  }
  const loaded = createInitialState();
  applySnapshot(loaded, storedSnapshot(state));
  loaded.messages.push({ role: 'user', text: '带着银鹿船票去旧港找老徐。' });
  const context = createEngine(loaded).buildKeeperMessages();
  assert.equal(loaded.scenario.investigation[0].nextScene, '市镇');
  assert.match(context[0].content, /旧港检票员认得伪造的船票/);
  assert.match(context[0].content, /老徐：带银鹿船票去旧港，我会等你/);
  assert.match(context[0].content, /钟楼夹层是空的/);

  const legacy = storedSnapshot(state);
  delete legacy.state.scenario.investigation;
  applySnapshot(loaded, legacy);
  assert.ok(loaded.scenario.investigation.some((entry) => entry.text.includes('老徐：带银鹿船票')));
});

test('导入模组优先使用原稿开场和终局，不把 AI 场景索引当作路线', () => {
  const module = {
    understanding: {},
    raw: `场景流程：推测的路径 → 推测的结尾\n===== 以下为原始素材（供查阅）=====\n场景流程：港口 → 灯塔（终局）\n开场白：雾里有人在敲钟。\n### 背景资料\n${'无关背景。\n\n'.repeat(2600)}\n终局：须确认灯塔信号的来历。`
  };
  assert.deepEqual(readModuleGuide(module).route, ['港口', '灯塔']);
  assert.equal(openingSceneFor(module), '港口');
  assert.equal(openingFor(module), '雾里有人在敲钟。');
  assert.deepEqual(readModuleGuide({ ...module, raw: '场景流程：推测的路径 → 推测的结尾' }).route, []);
  assert.deepEqual(readModuleGuide({ raw: '场景流程：甲 → 乙\n场景流程：甲 → 丙' }).route, []);
  const state = createInitialState();
  state.module = module;
  state.scenario.scene = '港口';
  const [system] = createEngine(state).buildKeeperMessages();
  assert.match(system.content, /原稿路线：港口 → 灯塔/);
  assert.match(system.content, /原稿终局条件.*\n须确认灯塔信号的来历/);
});

test('守密人重写违规草稿且不发布其中的旁白、线索或伤害，按相邻场景推进后结团', async () => {
  const state = createInitialState();
  state.module = BUILTIN_MODULES[0];
  state.scenario.scene = openingSceneFor(state.module);
  state.playerChar = createCharacter({ name: '林默', isPlayer: true });
  const health = state.playerChar.hp.current;
  const replies = [
    '虚构支线。[[HP:-4]][[CLUE:虚构线索]][[SCENE:外星飞船]]',
    '进入走廊。[[SCENE:走廊]]', '走向阁楼。[[SCENE:阁楼]]',
    '进入最后一处。[[SCENE:地下室]][[END:未查明就结束]]',
    '下到地下室。[[SCENE:地下室]]', '调查告一段落。[[END:完成封镇]]'
  ];
  let onChunk;
  let calls = 0;
  const engine = new GameEngine(state, {
    onChunk(fn) { onChunk = fn; return () => { onChunk = null; }; },
    async chat({ messages, requestId }) {
      if (calls === 1 || calls === 4) assert.match(messages[0].content, /重写上一个草稿/);
      assert.doesNotMatch(JSON.stringify(messages), /虚构支线|虚构线索|未查明就结束/);
      calls++;
      onChunk({ requestId, delta: replies.shift() });
      return { ok: true, text: '' };
    }
  });
  engine.on(ev => assert.notEqual(ev.type, 'stream-chunk', '模组草稿不可流入界面'));
  for (const action of ['走向走廊', '上楼去阁楼', '下到地下室', '完成封镇']) {
    assert.equal((await engine.takeTurn(action)).ok, true);
  }
  assert.deepEqual(state.messages.filter(m => m.role === 'scene').map(m => m.text), [
    '【场景】走廊', '【场景】阁楼', '【场景】地下室', '【模组结束】完成封镇'
  ]);
  assert.doesNotMatch(JSON.stringify(state.messages), /虚构支线|虚构线索|未查明就结束/);
  assert.equal(state.playerChar.hp.current, health);
  assert.equal(state.turns, 4);
  assert.equal(state.scenario.ended, true);
  assert.equal(calls, 6);
});

test('连续偏离模组后暂停，读档继续同一行动且不会保留越级换场', async () => {
  const state = createInitialState();
  state.module = { raw: '场景流程：甲 → 乙 → 丙（终局）' };
  state.scenario.scene = '甲';
  let calls = 0;
  const engine = createEngine(state, async () => ({
    ok: true, text: ++calls === 1 ? '走了捷径。[[SCENE:丙]]' : '调查结束。[[END:任意结局]]'
  }));
  assert.equal((await engine.takeTurn('出发')).ok, false);
  assert.equal(calls, 2);
  assert.equal(state.turns, 0);
  assert.equal(state.scenario.scene, '甲');
  assert.equal(state.scenario.ended, false);
  assert.ok(state.keeperContinuation.moduleCorrection);
  assert.doesNotMatch(JSON.stringify(state.messages), /走了捷径|任意结局/);
  const restored = applySnapshot(createInitialState(), storedSnapshot(state));
  const retry = createEngine(restored, async ({ messages }) => {
    assert.match(messages[0].content, /重写上一个草稿/);
    assert.equal(messages.filter(m => m.content === '出发').length, 1);
    return { ok: true, text: '前往乙。[[SCENE:乙]]' };
  });
  assert.equal((await retry.takeTurn('')).ok, true);
  assert.equal(restored.scenario.scene, '乙');
  assert.equal(restored.keeperContinuation, null);
  assert.equal(restored.turns, 1);
});

test('联机可认领、掷骰并用同一条消息 ID 更新公开结果', async () => {
  const host = createInitialState();
  const guest = createInitialState();
  host.playerChar = createCharacter({ name: '房主', isPlayer: true });
  const actor = createCharacter({ name: '客人' });
  host.teammates = [actor];
  host.module = { raw: '幕后内容' };
  host.scenario.secrets = ['隐藏证人'];
  host.net.role = 'host';
  host.net.players = [{ id: 'p1', charId: actor.id }];
  Object.assign(guest.net, { role: 'client', myPlayerId: 'p1', players: host.net.players });

  const replies = ['我听见声响。[[SAN:1/1]]', '声音停止了。'];
  const engine = createEngine(host, async () => ({ ok: true, text: replies.shift() }));
  engine.rollOwner = (ch) => rollOwner(host, ch);
  await engine.takeTurn('客人调查走廊。', { actorId: actor.id });
  const [roll] = engine.pendingRolls();
  assert.equal(roll.ownerId, 'p1');

  const state = () => JSON.parse(JSON.stringify(publicRoomState(host, { ready: true, busy: false })));
  applyRoomState(guest, state());
  mergeRoomMessages(guest, roomHistory(host), true);
  assert.equal(guest.playerChar.id, actor.id);
  assert.equal(guest.messages.find((message) => message.role === 'roll').data.id, roll.id);

  await engine.rollAndResume(roll.id);
  const messages = host.messages.slice(-3).map((message) => publicMessage(host, message)).filter(Boolean);
  const resolved = publicMessage(host, host.messages.find((message) => message.id === roll.messageId));
  mergeRoomMessages(guest, [resolved, ...messages], false);
  applyRoomState(guest, state());
  assert.equal(guest.messages.filter((message) => message.id === roll.messageId).length, 1);
  assert.equal(guest.messages.find((message) => message.id === roll.messageId).data.status, 'rolled');
  assert.equal(guest.playerChar.san.current, actor.san.current);
  assert.match(guest.messages.at(-1).text, /声音停止/);
  assert.doesNotMatch(JSON.stringify({ state: state(), messages: roomHistory(host) }), /幕后内容|隐藏证人|system-result|\[\[SAN/);
});

test('存档替换保留上一版可读记录，损坏主档时读取备份', (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'coc-save-flow-'));
  const file = join(dataRoot, 'data', 'save-auto.json');
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const load = Module._load;
  const handlers = new Map();
  Module._load = function (id, ...args) {
    if (id === 'electron') return {
      app: { getPath: () => dataRoot },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) }
    };
    return load.call(this, id, ...args);
  };
  t.after(() => {
    Module._load = load;
    const prefix = join(tmpdir(), 'coc-save-flow-');
    if (dataRoot.startsWith(prefix)) rmSync(dataRoot, { recursive: true, force: true });
  });
  require('../electron/ipc-files').registerSaveIpc();
  const call = (name, arg) => handlers.get(`save:${name}`)(null, arg);
  const save = (turns) => call('write', { slot: 'auto', state: { meta: { turns } } });
  save(4);
  save(5);
  assert.equal(call('read', 'auto').meta.turns, 5);
  writeFileSync(file, '{');
  assert.equal(call('read', 'auto').meta.turns, 4);
  assert.equal(call('list').length, 1);
  save(6);
  writeFileSync(file, '{');
  assert.equal(call('read', 'auto').meta.turns, 4);
  call('delete', 'auto');
  assert.equal(call('read', 'auto'), null);
});
