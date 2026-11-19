import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createCharacter } from '../src/core/character.js';
import { getHandler } from '../src/core/directives.js';
import { GameEngine } from '../src/core/engine.js';
import { createInitialState } from '../src/state.js';
import { applySnapshot, buildSnapshot } from '../src/persistence.js';
import { applyRoomState, mergeRoomMessages, publicMessage, publicRoomState, rollOwner, roomHistory } from '../src/core/onlineSession.js';

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
