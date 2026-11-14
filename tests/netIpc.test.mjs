// net-ipc 装配测试：用一个假的 electron 模块替换掉真的，
// 这样能在纯 node 里验证「IPC 处理器注册对不对、参数校验严不严」，
// 不需要真的启动 Electron 窗口。
'use strict';

import { createRequire } from 'module';
import Module from 'module';

const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const eq = (n, a, b) => (a === b ? ok(n) : bad(n, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n, `值为 ${JSON.stringify(v)}`));

// ---------------------------------------------------------------------------
// 桩：拦掉 require('electron')
// ---------------------------------------------------------------------------
const handlers = new Map();     // channel -> fn
const appListeners = new Map(); // event -> [fn]
const sent = [];                // 主进程 → 渲染层 的消息

const fakeIpcMain = {
  handle: (channel, fn) => { handlers.set(channel, fn); },
  on: (channel, fn) => { handlers.set(channel, fn); }
};

const fakeApp = {
  on: (event, fn) => {
    if (!appListeners.has(event)) appListeners.set(event, []);
    appListeners.get(event).push(fn);
  }
};

const fakeElectron = { ipcMain: fakeIpcMain, app: fakeApp };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

// 假的窗口：把 webContents.send 收到的都记下来
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (ch, payload) => sent.push({ ch, payload }) }
};
const getWindow = () => fakeWindow;

// ---------------------------------------------------------------------------
// 加载被测模块
// ---------------------------------------------------------------------------
const { registerNetIpc } = require('../electron/net-ipc.js');

/** 调一个已注册的 IPC 处理器 */
async function call(channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`处理器 ${channel} 没注册`);
  return fn({}, ...args);
}

function waitFor(predicate, ms = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error('等待超时'));
      setTimeout(tick, 25);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== 注册 ==');
  registerNetIpc(getWindow);

  const expected = [
    'net:hostStart', 'net:hostStop', 'net:hostBroadcast', 'net:hostSendTo',
    'net:hostSetChar', 'net:hostFindByChar', 'net:hostPlayers',
    'net:join', 'net:leave', 'net:send', 'net:clientStatus',
    'net:scanStart', 'net:scanStop', 'net:rooms', 'net:normalizeRoomCode',
    'net:localAddresses', 'net:shutdown'
  ];
  for (const ch of expected) {
    handlers.has(ch) ? ok(`注册了 ${ch}`) : bad(`缺少 ${ch}`);
  }
  truthy('注册了 before-quit 兜底清理', appListeners.has('before-quit'));

  console.log('\n== 未开房时的错误处理 ==');
  const noHost = await call('net:hostPlayers');
  eq('没开房时 hostPlayers 返回失败', noHost.ok, false);
  const noBroadcast = await call('net:hostBroadcast', { type: 'patch', payload: {} });
  eq('没开房时广播被拒', noBroadcast.ok, false);
  const noSend = await call('net:send', { kind: 'action', payload: { text: 'x' } });
  eq('没加入时发送被拒', noSend.ok, false);
  const noStatus = await call('net:clientStatus');
  eq('没加入时状态查询失败', noStatus.ok, false);

  console.log('\n== 开房 ==');
  const hosted = await call('net:hostStart', { hostName: '测试房主', maxPlayers: 3 });
  truthy('开房成功', hosted.ok);
  if (!hosted.ok) { console.log('  错误: ' + hosted.error); }
  eq('房间码 6 位', hosted.roomCode?.length, 6);
  truthy('端口有效', hosted.port > 0);
  console.log(`     端口=${hosted.port} 房间=${hosted.roomCode}`);

  const dup = await call('net:hostStart', {});
  eq('重复开房被拒', dup.ok, false);

  const info = await call('net:hostPlayers');
  truthy('开房后可查状态', info.ok);
  eq('初始 0 人', info.players.length, 0);

  console.log('\n== 广播白名单 ==');
  const badType = await call('net:hostBroadcast', { type: 'welcome', payload: {} });
  eq('禁止渲染层发 welcome', badType.ok, false);
  const badType2 = await call('net:hostBroadcast', { type: 'players', payload: {} });
  eq('禁止渲染层发 players', badType2.ok, false);
  const badType3 = await call('net:hostBroadcast', { type: 'hack', payload: {} });
  eq('未知类型被拒', badType3.ok, false);
  const goodBroadcast = await call('net:hostBroadcast', { type: 'patch', payload: { messages: [] } });
  truthy('合法类型可广播（0 人在线也算成功）', goodBroadcast.ok);

  console.log('\n== 真实客户端连入 ==');
  // 自己开房时 join 会被拒——这是设计，验证一下
  const selfJoin = await call('net:join', { host: '127.0.0.1', port: hosted.port, name: '自己' });
  eq('自己开房时拒绝加入', selfJoin.ok, false);
  truthy('拒绝原因是正在开房', /正在开房/.test(selfJoin.error || ''));

  // 用裸 ws 从外部连，验证服务真的可达，并且事件能转发到渲染层
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${hosted.port}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ t: 'hello', version: 1, name: '外部玩家' }));

  const welcome = await waitFor(() => {
    const m = sent.find((s) => s.ch === 'net:playerJoined');
    return m;
  });
  truthy('房主收到 playerJoined 事件', !!welcome);
  eq('事件里带玩家名', welcome.payload?.player?.name, '外部玩家');

  // 玩家列表也会推给渲染层
  await waitFor(() => sent.find((s) => s.ch === 'net:playerJoined'));
  const listAfter = await call('net:hostPlayers');
  eq('房主记录 1 人', listAfter.players.length, 1);

  console.log('\n== 认领与广播 ==');
  const pid = welcome.payload.player.id;
  ws.send(JSON.stringify({ t: 'claim', charId: 'char-x' }));
  const claimEvt = await waitFor(() => sent.find((s) => s.ch === 'net:claim'));
  eq('房主收到 claim', claimEvt.payload.charId, 'char-x');

  await call('net:hostSetChar', { playerId: pid, charId: 'char-x' });
  const found = await call('net:hostFindByChar', 'char-x');
  eq('查得到角色归属', found.player?.id, pid);

  const notFound = await call('net:hostFindByChar', 'char-none');
  eq('查不到的角色返回 null', notFound.player, null);

  // 广播 patch 应该真的发到客户端。
  // 注意：监听器要在广播**之前**挂上，否则会漏掉这条消息。
  const patchReceived = new Promise((resolve) => {
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.t === 'patch') {
          ws.off('message', onMsg);
          resolve(m);
        }
      } catch (e) { /* 不是 JSON 就跳过 */ }
    };
    ws.on('message', onMsg);
    setTimeout(() => resolve(null), 2000);
  });
  await call('net:hostBroadcast', { type: 'patch', payload: { messages: [{ role: 'keeper', text: '第二次' }] } });
  const patchMsg = await patchReceived;
  truthy('客户端真的收到了 patch', !!patchMsg);
  eq('patch 内容正确', patchMsg?.messages?.[0]?.text, '第二次');

  console.log('\n== 房间码与地址 ==');
  const norm = await call('net:normalizeRoomCode', 'ab-cd ef');
  eq('规范化成功', norm.code, 'ABCDEF');
  const normBad = await call('net:normalizeRoomCode', 'ABCIOO');
  eq('非法码被拒', normBad.ok, false);
  const addrs = await call('net:localAddresses');
  truthy('能取到本机地址列表', addrs.ok && Array.isArray(addrs.addresses));

  console.log('\n== 关房 ==');
  ws.close();
  const stopped = await call('net:hostStop');
  truthy('关房成功', stopped.ok);
  const afterStop = await call('net:hostPlayers');
  eq('关房后状态清空', afterStop.ok, false);

  console.log('\n== 加入房间（客户端路径）==');
  // 再开一个房，这次用 client 路径加入（要先关掉 host）
  const hosted2 = await call('net:hostStart', { hostName: '二号房主', maxPlayers: 2 });
  truthy('重新开房成功', hosted2.ok);

  // 起一个独立的 Host 实例扮演「别人的房间」，测试 client 路径
  const { Host } = require('../electron/net/host.js');
  const remoteHost = new Host({ maxPlayers: 2 });
  const remoteInfo = await remoteHost.start();

  // 先关掉自己的房，才能加入别人的
  await call('net:hostStop');
  const joined = await call('net:join', { host: '127.0.0.1', port: remoteInfo.port, name: '客户端玩家' });
  truthy('加入成功', joined.ok);
  if (!joined.ok) console.log('  错误: ' + joined.error);
  truthy('拿到 playerId', !!joined.playerId);

  const status = await call('net:clientStatus');
  eq('客户端状态 connected', status.connected, true);
  eq('客户端记住房主端口', status.port, remoteInfo.port);

  const sendOk = await call('net:send', { kind: 'action', payload: { text: '我看看窗外' } });
  truthy('客户端能发行动', sendOk.ok);

  const actionAtHost = await waitFor(() => remoteHost.players.size > 0 ? true : null);
  truthy('远端房主收到连接', !!actionAtHost);

  const leaveRes = await call('net:leave');
  truthy('离开房间成功', leaveRes.ok);
  const afterLeave = await call('net:clientStatus');
  eq('离开后状态清空', afterLeave.ok, false);

  console.log('\n== 连接失败的错误信息 ==');
  const badJoin = await call('net:join', { host: '127.0.0.1', port: 1, name: '连不上' });
  eq('连不上时返回失败', badJoin.ok, false);
  truthy('错误信息是人话', /连不上|超时|拒绝/.test(badJoin.error || ''));

  // 回归：加入失败后不能留下一个还在后台重连的 Client。
  // 之前的 bug 是 catch 里调 teardownClient()，但那时 activeClient 还是 null，
  // 于是一个没人管的 Client 会一直重试，进程永远退不掉。
  await sleep(1200);
  const stillNothing = await call('net:clientStatus');
  eq('加入失败后没有残留客户端', stillNothing.ok, false);

  console.log('\n== 关闭清理 ==');
  await call('net:shutdown');
  const finalStatus = await call('net:hostPlayers');
  eq('shutdown 后房主已关', finalStatus.ok, false);
  await remoteHost.close();

  // before-quit 兜底
  for (const fn of appListeners.get('before-quit') || []) {
    try { fn(); ok('before-quit 兜底清理不抛错'); } catch (e) { bad('before-quit 抛错', e.message); }
  }

  Module._load = origLoad;

  console.log('\n==========================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail === 0) console.log('全部通过'); else process.exitCode = 1;
})().catch((e) => {
  Module._load = origLoad;
  console.error('\n未捕获错误:', e);
  process.exitCode = 1;
});
