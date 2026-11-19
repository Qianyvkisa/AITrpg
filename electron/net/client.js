'use strict';

// ---------------------------------------------------------------------------
// 客户端：连到房主
//
// 断线自动重连，带指数退避。重连时把 token 带上，房主就能认出是「同一个
// 人回来了」而不是「新人加入」，这样角色和进度都不用重来。
// ---------------------------------------------------------------------------

const EventEmitter = require('events');
const WebSocket = require('ws');

const P = require('./protocol');

/** 重连退避序列（毫秒）。最后一项会一直重复，不会无限增长到不可用 */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15000];

class Client extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host 房主 IP
   * @param {number} opts.port 房主端口
   * @param {string} opts.name 玩家名
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = Number(opts.port) || 8787;
    this.name = opts.name || '玩家';

    this.ws = null;
    this.token = null;      // 房主发的重连凭证
    this.playerId = null;
    this.roomCode = null;
    this.connected = false;

    this._manualClose = false;
    this._reconnectTimer = null;
    this._attempt = 0;
    this._fatal = null;     // 致命错误（版本不符/房间满），重连也没意义
  }

  get url() {
    return `ws://${this.host}:${this.port}`;
  }

  /**
   * 发起连接。
   * @returns {Promise<{playerId:string, roomCode:string, reconnected:boolean}>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      this._manualClose = false;
      this._fatal = null;
      this._openSocket({ resolve, reject });
    });
  }

  _openSocket({ resolve, reject } = {}) {
    let settled = false;
    const settleOk = (v) => { if (!settled) { settled = true; resolve && resolve(v); } };
    const settleErr = (e) => { if (!settled) { settled = true; reject && reject(e); } };

    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 8000 });
    } catch (e) {
      settleErr(e);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      // 连上之后第一件事永远是 hello
      this._send(P.C2H.HELLO, {
        version: P.PROTOCOL_VERSION,
        name: this.name,
        token: this.token
      });
    });

    ws.on('message', (raw) => {
      const parsed = P.parse(raw);
      if (!parsed.ok) {
        this.emit('error', new Error(parsed.error));
        return;
      }
      const msg = parsed.msg;

      switch (msg.t) {
        case P.H2C.WELCOME:
          this.playerId = msg.playerId;
          this.token = msg.token || this.token;
          this.roomCode = msg.roomCode || this.roomCode;
          this.connected = true;
          this._attempt = 0;
          this.emit('welcome', {
            playerId: this.playerId,
            roomCode: this.roomCode,
            reconnected: !!msg.reconnected
          });
          settleOk({ playerId: this.playerId, roomCode: this.roomCode, reconnected: !!msg.reconnected });
          break;

        case P.H2C.ERROR:
          // fatal 的错误（版本不符、房间满）重连也没用，直接停
          if (msg.fatal) {
            this._fatal = new Error(msg.message);
            this._manualClose = true;
            this.emit('fatal', this._fatal);
            settleErr(this._fatal);
          } else {
            this.emit('server-error', msg.message);
          }
          break;

        case P.H2C.HOST_GONE:
          this.emit('host-gone', msg.reason || '房主离开了');
          this._manualClose = true;
          break;

        case P.H2C.PONG:
          break;

        default:
          // 其余消息原样往上抛，上层按类型处理
          this.emit('message', msg);
      }
    });

    ws.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.emit('disconnected', { wasConnected, willRetry: !this._manualClose && !this._fatal });

      if (!settled) {
        settleErr(new Error('连接被关闭'));
      }
      if (this._manualClose || this._fatal) return;
      this._scheduleReconnect();
    });

    ws.on('error', (e) => {
      // error 之后必然有 close，重连逻辑统一放在 close 里，避免重复调度
      this.emit('error', e);
      if (!settled) settleErr(e);
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(this._attempt, RECONNECT_DELAYS.length - 1)];
    this._attempt++;
    this.emit('reconnecting', { attempt: this._attempt, delay });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._manualClose || this._fatal) return;
      // 重连时不带 resolve/reject：结果通过 welcome / disconnected 事件通知
      this._openSocket({});
    }, delay);
  }

  /** 主动断开，不再重连 */
  close(reason = 'client closed') {
    this._manualClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, reason); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this.emit('closed');
  }

  // -------------------------------------------------------------------------
  // 发送
  // -------------------------------------------------------------------------

  _send(type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const data = P.encode(type, payload);
    if (data === null) return false;
    try {
      this.ws.send(data);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 认领一位调查员 */
  claim(charId) { return this._send(P.C2H.CLAIM, { charId }); }

  /** 提交本回合行动 */
  action(text) { return this._send(P.C2H.ACTION, { text }); }

  /** 掷自己的骰 */
  roll(pendingId) { return this._send(P.C2H.ROLL, { pendingId }); }

  /** 场外聊天 */
  chat(text) { return this._send(P.C2H.CHAT, { text }); }

  /** 表示已准备好进入下一轮 */
  ready() { return this._send(P.C2H.READY, {}); }

  /** 手动 ping，用于界面显示延迟 */
  ping() { return this._send(P.C2H.PING, {}); }
}

module.exports = { Client, RECONNECT_DELAYS };
