'use strict';

// ---------------------------------------------------------------------------
// 局域网发现：UDP 广播
//
// 目的只有一个——让朋友不用抄 IP。房主每隔一会儿在广播地址上喊一句
// 「我在，房间码是 XXX，端口是 N」，客户端监听这个端口就能列出附近的房间。
//
// 只在局域网生效。跨公网时这一层完全用不上，得靠手填 IP 或中继。
// ---------------------------------------------------------------------------

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

/** 发现用的固定端口。UDP 和 WebSocket 的端口不冲突，可以固定 */
const DISCOVER_PORT = 8788;

/** 广播间隔 */
const ANNOUNCE_INTERVAL_MS = 2000;

/** 一条房间信息多久没更新就认为消失了 */
const STALE_MS = 7000;

/** 广播包标识，避免收到无关的 UDP 流量被当成房间 */
const MAGIC = 'coc-rpg-room-v1';

/**
 * 房主侧：定时广播房间信息。
 */
class Announcer {
  constructor(opts = {}) {
    this.roomCode = opts.roomCode || '';
    this.port = opts.port || 0;
    this.hostName = opts.hostName || '';
    this.socket = null;
    this.timer = null;
  }

  start() {
    if (this.socket) return;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', () => {
      // 广播失败不影响联机本身：朋友还能手填 IP。静默降级。
      this.stop();
    });

    this.socket.bind(() => {
      try { this.socket.setBroadcast(true); } catch (e) {}
      this._announce();
      this.timer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL_MS);
      if (this.timer.unref) this.timer.unref();
    });
  }

  _announce() {
    if (!this.socket) return;
    const payload = Buffer.from(JSON.stringify({
      magic: MAGIC,
      roomCode: this.roomCode,
      port: this.port,
      hostName: this.hostName
    }));

    for (const target of broadcastTargets()) {
      try {
        this.socket.send(payload, 0, payload.length, DISCOVER_PORT, target, () => {});
      } catch (e) { /* 某个网卡发不出去不影响别的 */ }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
  }
}

/**
 * 客户端侧：监听广播，维护「附近有哪些房间」。
 * 收到的房间如果超过 STALE_MS 没再广播，就自动从列表里移除。
 */
class Scanner extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.rooms = new Map(); // roomCode -> { roomCode, port, host, hostName, lastSeen }
    this.cleanupTimer = null;
  }

  start() {
    if (this.socket) return;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (buf, rinfo) => {
      let obj;
      try {
        obj = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        return;
      }
      if (!obj || obj.magic !== MAGIC) return;
      if (typeof obj.roomCode !== 'string' || !obj.port) return;

      const prev = this.rooms.get(obj.roomCode);
      const room = {
        roomCode: obj.roomCode,
        port: Number(obj.port),
        host: rinfo.address,
        hostName: typeof obj.hostName === 'string' ? obj.hostName : '',
        lastSeen: Date.now()
      };
      this.rooms.set(obj.roomCode, room);
      // 新出现的房间才通知，避免每 2 秒刷一次界面
      if (!prev) this.emit('room', room);
      this.emit('update', this.list());
    });

    this.socket.on('error', () => {
      this.stop();
    });

    this.socket.bind({ port: DISCOVER_PORT, exclusive: false }, () => {
      try { this.socket.setBroadcast(true); } catch (e) {}
    });

    this.cleanupTimer = setInterval(() => this._cleanup(), ANNOUNCE_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  _cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [code, r] of this.rooms) {
      if (now - r.lastSeen > STALE_MS) {
        this.rooms.delete(code);
        changed = true;
      }
    }
    if (changed) this.emit('update', this.list());
  }

  /** 当前可见房间，最近出现的排前面 */
  list() {
    return [...this.rooms.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
    this.rooms.clear();
  }
}

/**
 * 计算该往哪些地址广播。
 * 只发 255.255.255.255 在某些系统上会被路由到默认网卡，多网卡环境下
 * 需要按每个网卡的子网算定向广播地址，否则朋友那台收不到。
 */
function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const bcast = subnetBroadcast(a.address, a.netmask);
      if (bcast) targets.add(bcast);
    }
  }
  return [...targets];
}

/** 由 IP 和掩码算出定向广播地址 */
function subnetBroadcast(address, netmask) {
  try {
    const ip = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4) return null;
    const out = ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255));
    return out.join('.');
  } catch (e) {
    return null;
  }
}

module.exports = {
  DISCOVER_PORT,
  ANNOUNCE_INTERVAL_MS,
  STALE_MS,
  MAGIC,
  Announcer,
  Scanner,
  broadcastTargets,
  subnetBroadcast
};
