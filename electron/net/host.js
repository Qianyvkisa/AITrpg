'use strict';

// ---------------------------------------------------------------------------
// 房主端：WebSocket 服务
//
// 只负责「谁连上来了、他说了什么、把话发给谁」。不含任何游戏逻辑——
// 游戏逻辑在渲染层的 engine 里，这一层把收到的消息往上抛事件，
// 由上层决定怎么响应。这样网络层可以脱离 Electron 单独测试。
// ---------------------------------------------------------------------------

const EventEmitter = require('events');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const P = require('./protocol');
const { makeRoomCode, findFreePort, primaryLocalAddress, DEFAULT_PORT } = require('./room');

/** 心跳间隔：超过这个时间没 pong 就认为掉线 */
const HEARTBEAT_MS = 15000;

/** 单个玩家连续发送的速率上限（条/秒），防刷屏 */
const RATE_LIMIT_PER_SEC = 8;

class Host extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.roomCode = opts.roomCode || makeRoomCode();
    this.port = opts.port || DEFAULT_PORT;
    this.maxPlayers = Math.min(Math.max(opts.maxPlayers || 4, 2), 8);

    this.wss = null;
    this.players = new Map(); // playerId -> player
    this.tokens = new Map();  // token -> playerId（重连用）
    this.heartbeatTimer = null;
    this.started = false;
    this._seq = 0;
  }

  /** 当前实际监听的端口（start 之后才知道，可能和构造时不同） */
  get actualPort() {
    return this.wss ? this.wss.address()?.port ?? this.port : this.port;
  }

  /**
   * 启动服务。会自动挑一个空闲端口。
   * @returns {Promise<{port:number, roomCode:string, address:string|null}>}
   */
  async start() {
    if (this.started) throw new Error('服务已在运行');

    const port = await findFreePort(this.port);
    this.port = port;

    this.wss = new WebSocketServer({
      port,
      host: '0.0.0.0',
      maxPayload: P.MAX_MESSAGE_BYTES,
      // 局域网熟人局，不校验 Origin：Electron 渲染层是 file:// 或
      // 自定义协议，Origin 头对不上是正常的，校验反而会挡住自己
      verifyClient: () => true
    });

    await new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      this.wss.once('error', onError);
      this.wss.once('listening', () => {
        this.wss.off('error', onError);
        resolve();
      });
    });

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    this.heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();

    this.started = true;
    return { port, roomCode: this.roomCode, address: primaryLocalAddress() };
  }

  /** 关闭服务，断开所有人 */
  async close() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const p of this.players.values()) {
      try {
        this._sendRaw(p.ws, P.H2C.HOST_GONE, { reason: '房主关闭了房间' });
        p.ws.close(1001, 'host closed');
      } catch (e) { /* 已经断了就算了 */ }
    }
    this.players.clear();
    this.tokens.clear();

    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise((resolve) => wss.close(() => resolve()));
    }
    this.started = false;
    this.emit('closed');
  }

  // -------------------------------------------------------------------------
  // 连接处理
  // -------------------------------------------------------------------------

  _onConnection(ws, req) {
    // 每个连接先处于「未认证」状态，收到合法 hello 之后才成为玩家。
    // 不能一连上就给 playerId：那样任何人都能占坑。
    ws.__authed = false;
    ws.__rate = { windowStart: Date.now(), count: 0 };
    ws.__remote = (req && req.socket && req.socket.remoteAddress) || '?';

    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', (code, reason) => this._onClose(ws, code, reason));
    ws.on('error', () => { /* close 会跟着来，这里吞掉避免未捕获异常 */ });
    ws.on('pong', () => { ws.__alive = true; });

    ws.__alive = true;
  }

  _onMessage(ws, raw) {
    const parsed = P.parse(raw);
    if (!parsed.ok) {
      this._sendRaw(ws, P.H2C.ERROR, { message: parsed.error });
      return;
    }
    const msg = parsed.msg;

    if (!this._checkRate(ws)) {
      this._sendRaw(ws, P.H2C.ERROR, { message: '发送太快了，慢一点' });
      return;
    }

    if (msg.t === P.C2H.PING) {
      this._sendRaw(ws, P.H2C.PONG, {});
      return;
    }

    // 未认证连接只接受 hello
    if (!ws.__authed) {
      if (msg.t !== P.C2H.HELLO) {
        this._sendRaw(ws, P.H2C.ERROR, { message: '请先发送 hello' });
        return;
      }
      this._handleHello(ws, msg);
      return;
    }

    const player = this.players.get(ws.__playerId);
    if (!player || player.ws !== ws) return;

    switch (msg.t) {
      case P.C2H.HELLO:
        this._sendRaw(ws, P.H2C.ERROR, { message: '已经加入过了' });
        break;

      case P.C2H.CLAIM: {
        const v = P.validateClaim(msg);
        if (!v.ok) { this._sendRaw(ws, P.H2C.ERROR, { message: v.error }); return; }
        this.emit('claim', { player, charId: v.value.charId });
        break;
      }

      case P.C2H.ACTION: {
        const v = P.validateAction(msg);
        if (!v.ok) { this._sendRaw(ws, P.H2C.ERROR, { message: v.error }); return; }
        this.emit('action', { player, text: v.value.text });
        break;
      }

      case P.C2H.ROLL: {
        const v = P.validateRoll(msg);
        if (!v.ok) { this._sendRaw(ws, P.H2C.ERROR, { message: v.error }); return; }
        this.emit('roll', { player, pendingId: v.value.pendingId });
        break;
      }

      case P.C2H.CHAT: {
        const v = P.validateChat(msg);
        if (!v.ok) { this._sendRaw(ws, P.H2C.ERROR, { message: v.error }); return; }
        this.emit('chat', { player, text: v.value.text });
        break;
      }

      case P.C2H.READY:
        this.emit('ready', { player });
        break;

      default:
        this._sendRaw(ws, P.H2C.ERROR, { message: `房主不认识消息 ${msg.t}` });
    }
  }

  _handleHello(ws, msg) {
    const v = P.validateHello(msg);
    if (!v.ok) {
      this._sendRaw(ws, P.H2C.ERROR, { message: v.error, fatal: true });
      // 版本不一致没必要让连接挂着，给客户端一次机会读错误再关
      setTimeout(() => { try { ws.close(1008, 'handshake failed'); } catch (e) {} }, 50);
      return;
    }
    const { name, token } = v.value;

    // 重连：token 对得上就恢复原来的身份和角色，不占新坑
    if (token && this.tokens.has(token)) {
      const pid = this.tokens.get(token);
      const old = this.players.get(pid);
      if (old) {
        try { old.ws.close(1000, 'replaced by reconnect'); } catch (e) {}
        old.ws = ws;
        old.alive = true;
        ws.__authed = true;
        ws.__playerId = pid;
        ws.__alive = true;
        this._sendRaw(ws, P.H2C.WELCOME, {
          playerId: pid,
          token: old.token,
          roomCode: this.roomCode,
          reconnected: true
        });
        this.emit('player-reconnected', { player: old });
        this.broadcastPlayers();
        return;
      }
    }

    // 人满
    if (this.players.size >= this.maxPlayers) {
      this._sendRaw(ws, P.H2C.ERROR, { message: `房间已满（上限 ${this.maxPlayers} 人）`, fatal: true });
      setTimeout(() => { try { ws.close(1008, 'room full'); } catch (e) {} }, 50);
      return;
    }

    const playerId = this._nextPlayerId();
    const newToken = crypto.randomBytes(16).toString('hex');
    const player = {
      id: playerId,
      name,
      token: newToken,
      ws,
      charId: null,
      alive: true,
      joinedAt: Date.now()
    };
    this.players.set(playerId, player);
    this.tokens.set(newToken, playerId);

    ws.__authed = true;
    ws.__playerId = playerId;
    ws.__alive = true;

    this._sendRaw(ws, P.H2C.WELCOME, {
      playerId,
      token: newToken,
      roomCode: this.roomCode,
      reconnected: false
    });

    this.emit('player-joined', { player });
    this.broadcastPlayers();
  }

  _onClose(ws, code, reason) {
    if (!ws.__authed) return;
    const pid = ws.__playerId;
    const player = this.players.get(pid);
    if (!player || player.ws !== ws) return;

    // 标记离线但保留 token，让他还能重连回来接原角色
    player.alive = false;
    player.ws = null;
    if (code === 1000 && String(reason) === 'left room') {
      this.players.delete(pid);
      this.tokens.delete(player.token);
    }
    this.emit('player-offline', { player });
    this.broadcastPlayers();
  }

  _checkRate(ws) {
    const now = Date.now();
    const r = ws.__rate;
    if (now - r.windowStart > 1000) {
      r.windowStart = now;
      r.count = 0;
    }
    r.count++;
    return r.count <= RATE_LIMIT_PER_SEC;
  }

  _heartbeat() {
    for (const [pid, p] of this.players) {
      if (!p.ws) continue;
      if (p.ws.__alive === false) {
        try { p.ws.terminate(); } catch (e) {}
        p.alive = false;
        p.ws = null;
        this.emit('player-offline', { player: p });
        this.broadcastPlayers();
        continue;
      }
      p.ws.__alive = false;
      try { p.ws.ping(); } catch (e) {}
    }
  }

  _nextPlayerId() {
    // 用递增序号而不是随机：方便在日志里看出加入顺序
    this._seq++;
    return `p${this._seq}`;
  }

  // -------------------------------------------------------------------------
  // 发送
  // -------------------------------------------------------------------------

  _sendRaw(ws, type, payload) {
    if (!ws || ws.readyState !== 1) return false;
    const data = P.encode(type, payload);
    if (data === null) return false;
    try {
      ws.send(data);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 给单个玩家发 */
  sendTo(playerId, type, payload) {
    const p = this.players.get(playerId);
    if (!p || !p.ws) return false;
    return this._sendRaw(p.ws, type, payload);
  }

  /** 给所有人（含可选排除某人）广播 */
  broadcast(type, payload, exceptPlayerId = null) {
    let n = 0;
    for (const [pid, p] of this.players) {
      if (exceptPlayerId && pid === exceptPlayerId) continue;
      if (!p.ws) continue;
      if (this._sendRaw(p.ws, type, payload)) n++;
    }
    return n;
  }

  /** 广播玩家列表：只发必要字段，token 绝不出房间 */
  broadcastPlayers() {
    const list = [];
    for (const p of this.players.values()) {
      list.push({
        id: p.id,
        name: p.name,
        charId: p.charId,
        online: !!p.ws
      });
    }
    this.broadcast(P.H2C.PLAYERS, { players: list });
  }

  /** 更新某玩家的角色认领，并广播 */
  setPlayerChar(playerId, charId) {
    const p = this.players.get(playerId);
    if (!p) return false;
    if (charId && [...this.players.values()].some((other) => other !== p && other.charId === charId)) return false;
    p.charId = charId || null;
    this.broadcastPlayers();
    return true;
  }

  /** 谁认领了这个角色（用于「两人抢同一角色」判断） */
  findPlayerByChar(charId) {
    for (const p of this.players.values()) {
      if (p.charId === charId && p.ws) return p;
    }
    return null;
  }

  /** 当前在线玩家数 */
  get onlineCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.ws) n++;
    return n;
  }
}

module.exports = { Host, HEARTBEAT_MS, RATE_LIMIT_PER_SEC };
