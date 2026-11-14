// 阶段 1 冒烟测试：起真实 WebSocket，验证 连接 → hello → 认领 → 行动 → 广播 → 重连
// 全部在 127.0.0.1 上跑，端口由系统分配，不依赖 Electron。
'use strict';

// 网络层是 CommonJS（和 main.js 一致），这里用 createRequire 桥接进 ESM 测试
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { Host } = require('../electron/net/host.js');
const { Client } = require('../electron/net/client.js');
const P = require('../electron/net/protocol.js');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function eq(name, actual, expected) {
  if (actual === expected) ok(name);
  else bad(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function truthy(name, v) { if (v) ok(name); else bad(name, `值为 ${JSON.stringify(v)}`); }

function waitFor(emitter, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), ms);
    emitter.once(event, (...args) => { clearTimeout(t); resolve(args); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('== 房间码与端口 ==');
  const room = require('../electron/net/room.js');
  const code = room.makeRoomCode();
  eq('房间码长度 6', code.length, 6);
  truthy('房间码只用安全字符', [...code].every(c => room.ROOM_ALPHABET.includes(c)));
  truthy('房间码不含易混字符 I/O', !/[IO]/.test(code));
  eq('规范化去空格与连字符', room.normalizeRoomCode(' ab-cde f '), 'ABCDEF');
  eq('规范化转大写', room.normalizeRoomCode('abcdef'), 'ABCDEF');
  eq('规范化拒绝含 I', room.normalizeRoomCode('ABCDEI'), null);
  eq('规范化拒绝长度不对', room.normalizeRoomCode('ABC'), null);
  eq('规范化拒绝空', room.normalizeRoomCode(''), null);

  console.log('\n== 协议校验 ==');
  eq('解析非 JSON', P.parse('not json').ok, false);
  eq('解析空消息', P.parse(null).ok, false);
  eq('解析数组', P.parse('[]').ok, false);
  eq('解析缺 t', P.parse('{"a":1}').ok, false);
  eq('解析未知类型', P.parse('{"t":"hack"}').ok, false);
  eq('解析合法 hello', P.parse('{"t":"hello","version":1,"name":"甲"}').ok, true);
  eq('超大消息被拒', P.parse(Buffer.alloc(P.MAX_MESSAGE_BYTES + 1)).ok, false);

  eq('hello 版本不符被拒', P.validateHello({ t: 'hello', version: 999, name: '甲' }).ok, false);
  eq('hello 缺名字被拒', P.validateHello({ t: 'hello', version: 1, name: '  ' }).ok, false);
  const longName = P.validateHello({ t: 'hello', version: 1, name: 'x'.repeat(100) });
  eq('hello 名字被截断', longName.value.name.length, P.MAX_NAME_LEN);

  console.log('\n== 房主启动 ==');
  const host = new Host({ maxPlayers: 3 });
  const info = await host.start();
  truthy('服务已启动', host.started);
  truthy('拿到端口', info.port > 0);
  eq('房间码长度 6', info.roomCode.length, 6);
  console.log(`     监听 127.0.0.1:${info.port} 房间 ${info.roomCode}`);

  console.log('\n== 客户端连接 ==');
  const c1 = new Client({ host: '127.0.0.1', port: info.port, name: '张三' });
  const w1 = await c1.connect();
  truthy('拿到 playerId', !!w1.playerId);
  truthy('拿到 token', !!c1.token);
  eq('房间码一致', w1.roomCode, info.roomCode);
  eq('首次连接不是重连', w1.reconnected, false);

  // 第二个客户端，验证多人
  const c2 = new Client({ host: '127.0.0.1', port: info.port, name: '李四' });
  const w2 = await c2.connect();
  truthy('第二人拿到不同 playerId', w2.playerId !== w1.playerId);
  await sleep(100);
  eq('房主记录 2 人在线', host.onlineCount, 2);

  console.log('\n== 认领与行动 ==');
  const claimEvt = waitFor(host, 'claim');
  c1.claim('char-a');
  const [claimPayload] = await claimEvt;
  eq('房主收到认领', claimPayload.charId, 'char-a');
  eq('认领者名字正确', claimPayload.player.name, '张三');

  host.setPlayerChar(w1.playerId, 'char-a');
  eq('查得到角色归属', host.findPlayerByChar('char-a')?.id, w1.playerId);

  const actionEvt = waitFor(host, 'action');
  c1.action('  我推开门  ');
  const [actPayload] = await actionEvt;
  eq('行动文本已 trim', actPayload.text, '我推开门');
  eq('行动来源正确', actPayload.player.id, w1.playerId);

  const emptyEvt = waitFor(c2, 'server-error');
  c2.action('   ');
  const [emptyErr] = await emptyEvt;
  truthy('空行动被拒并回错误', /为空/.test(emptyErr));

  console.log('\n== 广播 ==');
  const patchEvt = waitFor(c2, 'message');
  host.broadcast(P.H2C.PATCH, { messages: [{ role: 'keeper', text: '门后一片漆黑' }] });
  const [patchMsg] = await patchEvt;
  eq('客户端收到 patch 类型', patchMsg.t, P.H2C.PATCH);
  eq('patch 正文正确', patchMsg.messages[0].text, '门后一片漆黑');

  console.log('\n== 重连 ==');
  const oldToken = c1.token;
  const oldId = w1.playerId;
  const reconnectEvt = waitFor(host, 'player-reconnected', 6000);
  c1.close();
  await sleep(150);
  eq('掉线后在线数减少', host.onlineCount, 1);

  // 用同一个 token 重新连
  const c1b = new Client({ host: '127.0.0.1', port: info.port, name: '张三' });
  c1b.token = oldToken;
  const w1b = await c1b.connect();
  const [reconPayload] = await reconnectEvt;
  eq('重连是重连不是新加入', w1b.reconnected, true);
  eq('重连拿回同一 playerId', w1b.playerId, oldId);
  eq('房主侧识别为同一玩家', reconPayload.player.id, oldId);
  await sleep(100);
  eq('重连后在线数恢复', host.onlineCount, 2);

  console.log('\n== 房间满 ==');
  const c3 = new Client({ host: '127.0.0.1', port: info.port, name: '王五' });
  await c3.connect();
  const c4 = new Client({ host: '127.0.0.1', port: info.port, name: '赵六' });
  let fullErr = null;
  c4.on('fatal', (e) => { fullErr = e; });
  try { await c4.connect(); } catch (e) { fullErr = fullErr || e; }
  await sleep(200);
  truthy('第 4 人被拒（上限 3）', fullErr && /满/.test(fullErr.message));

  console.log('\n== 版本不符 ==');
  // 用裸 WebSocket 手发一个错误版本号，模拟「对方是老版本」
  const WebSocket = require('ws');
  const badWs = new WebSocket(`ws://127.0.0.1:${info.port}`);
  const verErr = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    badWs.on('open', () => {
      badWs.send(JSON.stringify({ t: 'hello', version: 999, name: '老版本' }));
    });
    badWs.on('message', (raw) => {
      clearTimeout(t);
      try { resolve(JSON.parse(raw.toString())); } catch (e) { resolve(null); }
    });
    badWs.on('error', () => { clearTimeout(t); resolve(null); });
  });
  truthy('版本不符被明确拒绝', verErr && verErr.t === P.H2C.ERROR && /版本/.test(verErr.message));
  eq('拒绝是致命错误（不重连）', verErr && verErr.fatal, true);
  try { badWs.close(); } catch (e) {}

  console.log('\n== 关闭 ==');
  c1b.close(); c2.close(); c3.close(); c4.close();
  await host.close();
  eq('服务已停止', host.started, false);

  console.log('\n==========================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail === 0) console.log('全部通过'); else process.exitCode = 1;
})().catch((e) => {
  console.error('\n未捕获错误:', e);
  process.exitCode = 1;
});
