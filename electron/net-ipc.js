'use strict';

// ---------------------------------------------------------------------------
// 联机 IPC 装配：把 electron/net 里的网络模块接到渲染层
//
// 分工：
//   主进程  — 持有 socket、房间码、端口、玩家列表
//   渲染层  — 只做界面和游戏逻辑，通过 IPC 收发
//
// 为什么网络必须放主进程：渲染层 CSP 是 default-src 'self'，
// 而且渲染层一旦能直连 socket，API Key 就有了被顺手带出去的可能。
// 放主进程还顺带解决了「客户端永远拿不到 Key」这件事。
// ---------------------------------------------------------------------------

const crashlog = require('./crashlog');
const { Host } = require('./net/host');
const { Client } = require('./net/client');
const { Announcer, Scanner } = require('./net/discover');
const { normalizeRoomCode, listLocalAddresses, primaryLocalAddress } = require('./net/room');
const P = require('./net/protocol');

/** 当前活动的房主 / 客户端，同一时间只允许一个（一个人不能既开房又进房） */
let activeHost = null;
let activeClient = null;
let announcer = null;
let scanner = null;

/** 把主进程侧事件转发到渲染层，统一走这一个通道 */
function emitToRenderer(getWindow, channel, payload) {
  const win = getWindow && getWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (e) {
    crashlog.log('net: emit failed ' + channel + ' ' + e.message);
  }
}

/** 清掉房主相关的一切 */
async function teardownHost() {
  if (announcer) {
    announcer.stop();
    announcer = null;
  }
  if (activeHost) {
    const h = activeHost;
    activeHost = null;
    try { await h.close(); } catch (e) { /* 已经关了 */ }
  }
}

/** 清掉客户端相关的一切 */
function teardownClient(reason) {
  if (activeClient) {
    const c = activeClient;
    activeClient = null;
    try { c.close(reason); } catch (e) { /* 已经断了 */ }
  }
}

function registerNetIpc(getWindow) {
  const { ipcMain } = require('electron');

  const push = (channel) => (payload) => emitToRenderer(getWindow, channel, payload);
  const pushPlayer = (channel) => ({ player, ...payload }) => push(channel)({
    ...payload,
    player: { id: player.id, name: player.name, charId: player.charId, online: !!player.ws }
  });

  // -------------------------------------------------------------------------
  // 开房
  // -------------------------------------------------------------------------
  ipcMain.handle('net:hostStart', async (_e, opts = {}) => {
    if (activeHost) return { ok: false, error: '已经在开房了' };
    teardownClient();

    try {
      const host = new Host({
        maxPlayers: opts.maxPlayers,
        hostName: opts.hostName || ''
      });

      // 网络事件 → 渲染层。这里只转发，不解释，游戏逻辑在渲染层。
      host.on('player-joined', pushPlayer('net:playerJoined'));
      host.on('player-offline', pushPlayer('net:playerOffline'));
      host.on('player-reconnected', pushPlayer('net:playerReconnected'));
      host.on('claim', pushPlayer('net:claim'));
      host.on('action', pushPlayer('net:action'));
      host.on('roll', pushPlayer('net:roll'));
      host.on('chat', pushPlayer('net:chat'));
      host.on('ready', pushPlayer('net:ready'));

      const info = await host.start();
      activeHost = host;

      // 局域网广播，让朋友不用抄 IP。失败不影响联机。
      announcer = new Announcer({
        roomCode: info.roomCode,
        port: info.port,
        hostName: opts.hostName || ''
      });
      announcer.start();

      crashlog.log(`net: host started port=${info.port} room=${info.roomCode}`);

      return {
        ok: true,
        roomCode: info.roomCode,
        port: info.port,
        address: info.address,
        addresses: listLocalAddresses()
      };
    } catch (e) {
      crashlog.log('net: hostStart failed ' + e.message);
      await teardownHost();
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:hostStop', async () => {
    await teardownHost();
    return { ok: true };
  });

  // 房主广播。type 由渲染层决定（patch / stream / pending / turn 等）
  ipcMain.handle('net:hostBroadcast', (_e, { type, payload, exceptPlayerId } = {}) => {
    if (!activeHost) return { ok: false, error: '没有在开房' };
    if (!type || !Object.values(P.H2C).includes(type)) {
      return { ok: false, error: `不能广播 ${type}` };
    }
    // welcome/players 这类由房主自己管的消息不让渲染层乱发
    if (type === P.H2C.WELCOME || type === P.H2C.PLAYERS) {
      return { ok: false, error: `${type} 由主进程管理` };
    }
    const n = activeHost.broadcast(type, payload || {}, exceptPlayerId || null);
    return { ok: true, sent: n };
  });

  ipcMain.handle('net:hostSendTo', (_e, { playerId, type, payload } = {}) => {
    if (!activeHost) return { ok: false, error: '没有在开房' };
    if (!type || !Object.values(P.H2C).includes(type)) {
      return { ok: false, error: `不能发送 ${type}` };
    }
    const sent = activeHost.sendTo(playerId, type, payload || {});
    return { ok: sent };
  });

  // 房主侧认领角色（房主自己也是玩家，他直接改内存，不走网络）
  ipcMain.handle('net:hostSetChar', (_e, { playerId, charId } = {}) => {
    if (!activeHost) return { ok: false, error: '没有在开房' };
    return { ok: activeHost.setPlayerChar(playerId, charId) };
  });

  // 谁占了这个角色？用于「两人抢同一角色」
  ipcMain.handle('net:hostFindByChar', (_e, charId) => {
    if (!activeHost) return { ok: false, error: '没有在开房' };
    const p = activeHost.findPlayerByChar(charId);
    return { ok: true, player: p ? { id: p.id, name: p.name } : null };
  });

  ipcMain.handle('net:hostPlayers', () => {
    if (!activeHost) return { ok: false, error: '没有在开房' };
    const list = [];
    for (const p of activeHost.players.values()) {
      list.push({ id: p.id, name: p.name, charId: p.charId, online: !!p.ws });
    }
    return { ok: true, players: list, roomCode: activeHost.roomCode, port: activeHost.actualPort };
  });

  // -------------------------------------------------------------------------
  // 加入
  // -------------------------------------------------------------------------
  ipcMain.handle('net:join', async (_e, { host, port, name } = {}) => {
    if (activeClient) teardownClient();
    if (activeHost) return { ok: false, error: '自己正在开房，不能同时加入别的房间' };

    // 注意：connect() 失败时 activeClient 还没被赋值，所以这里必须用局部变量
    // 来兜底关闭。否则那个 Client 实例的重连定时器会一直跑下去——
    // 表现为「加入失败后程序退不掉、后台还在反复重试连一个不存在的房间」。
    const client = new Client({
      host: String(host || '').trim(),
      port: Number(port),
      name: String(name || '').trim() || '玩家'
    });

    try {
      // 客户端事件 → 渲染层
      client.on('welcome', push('net:welcome'));
      client.on('message', push('net:message'));
      client.on('server-error', push('net:serverError'));
      client.on('error', (e) => push('net:clientError')({ message: e.message }));
      client.on('fatal', push('net:fatal'));
      client.on('host-gone', push('net:hostGone'));
      client.on('disconnected', push('net:disconnected'));
      client.on('reconnecting', push('net:reconnecting'));

      const res = await client.connect();
      activeClient = client;

      crashlog.log(`net: joined ${host}:${port} as ${res.playerId}`);
      return { ok: true, ...res };
    } catch (e) {
      crashlog.log('net: join failed ' + e.message);
      // 关掉这个没连上的实例，别让它留在后台重连
      try { client.close(); } catch (_) { /* 已经断了 */ }
      return { ok: false, error: friendlyConnectError(e, host, port) };
    }
  });

  ipcMain.handle('net:leave', () => {
    teardownClient('left room');
    return { ok: true };
  });

  ipcMain.handle('net:send', (_e, { kind, payload } = {}) => {
    if (!activeClient) return { ok: false, error: '还没加入房间' };
    let sent = false;
    switch (kind) {
      case 'claim': sent = activeClient.claim(payload?.charId); break;
      case 'action': sent = activeClient.action(payload?.text); break;
      case 'roll': sent = activeClient.roll(payload?.pendingId); break;
      case 'chat': sent = activeClient.chat(payload?.text); break;
      case 'ready': sent = activeClient.ready(); break;
      case 'ping': sent = activeClient.ping(); break;
      default: return { ok: false, error: `未知发送类型 ${kind}` };
    }
    return { ok: sent };
  });

  ipcMain.handle('net:clientStatus', () => {
    if (!activeClient) return { ok: false, error: '还没加入房间' };
    return {
      ok: true,
      connected: activeClient.connected,
      playerId: activeClient.playerId,
      roomCode: activeClient.roomCode,
      host: activeClient.host,
      port: activeClient.port
    };
  });

  // -------------------------------------------------------------------------
  // 局域网发现
  // -------------------------------------------------------------------------
  ipcMain.handle('net:scanStart', () => {
    if (scanner) return { ok: true, rooms: scanner.list() };
    scanner = new Scanner();
    scanner.on('update', push('net:rooms'));
    scanner.start();
    return { ok: true, rooms: [] };
  });

  ipcMain.handle('net:scanStop', () => {
    if (scanner) {
      scanner.stop();
      scanner = null;
    }
    return { ok: true };
  });

  ipcMain.handle('net:rooms', () => {
    return { ok: true, rooms: scanner ? scanner.list() : [] };
  });

  // 房间码规范化放在主进程做：渲染层传什么都不能信
  ipcMain.handle('net:normalizeRoomCode', (_e, input) => {
    const code = normalizeRoomCode(input);
    return code ? { ok: true, code } : { ok: false, error: '房间码格式不对（6 位，不含 I/O）' };
  });

  ipcMain.handle('net:localAddresses', () => {
    return { ok: true, addresses: listLocalAddresses(), primary: primaryLocalAddress() };
  });

  // 退出前必须把 socket 关干净，否则端口会一直占着
  ipcMain.handle('net:shutdown', async () => {
    await teardownHost();
    teardownClient();
    if (scanner) { scanner.stop(); scanner = null; }
    return { ok: true };
  });

  // 主进程退出兜底：不管渲染层有没有主动关，这里都要清
  const { app } = require('electron');
  app.on('before-quit', () => {
    try { teardownHost(); } catch (e) {}
    try { teardownClient(); } catch (e) {}
    try { if (scanner) { scanner.stop(); scanner = null; } } catch (e) {}
  });
}

/**
 * 把底层 socket 错误翻译成人能看懂的话。
 * 直接抛 ECONNREFUSED 给玩家看等于没说。
 */
function friendlyConnectError(e, host, port) {
  const msg = String(e && e.message || e);
  if (/ECONNREFUSED/i.test(msg)) {
    return `连不上 ${host}:${port}。确认房主已经开了房间，并且端口填对了。`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `找不到主机 ${host}。检查一下 IP 有没有抄错。`;
  }
  if (/ETIMEDOUT|timeout/i.test(msg)) {
    return `连接 ${host}:${port} 超时。可能是防火墙挡住了，或者两台机器不在同一个网络。`;
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return `网络不可达：${host}。确认两台机器连的是同一个 WiFi。`;
  }
  return msg;
}

module.exports = { registerNetIpc };
