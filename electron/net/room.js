'use strict';

// ---------------------------------------------------------------------------
// 房间码与端口
//
// 房间码是给人抄的，所以字符集必须排除容易看错的 0/O、1/I/L。
// 端口从固定起点往上找，避免每次开房都撞车。
// ---------------------------------------------------------------------------

const net = require('net');
const crypto = require('crypto');

/**
 * 房间码字符集：24 个字母（去掉 I、O）+ 8 个数字（2-9）。
 * 32^6 ≈ 10.7 亿，熟人局够用。
 */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 房间码长度 */
const ROOM_CODE_LEN = 6;

/** 默认端口起点与探测范围 */
const DEFAULT_PORT = 8787;
const PORT_SCAN_LIMIT = 11; // 8787..8797

/**
 * 生成一个房间码。
 * 用 crypto.randomInt 而不是 Math.random：房间码是唯一的准入凭证，
 * 可预测的话等于没有。
 */
function makeRoomCode() {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_ALPHABET[crypto.randomInt(0, ROOM_ALPHABET.length)];
  }
  return out;
}

/**
 * 规范化用户输入的房间码：去掉空格/连字符、转大写，
 * 顺便把常见误抄的 O→0 之类做不回来的就不做，只做大小写与分隔符。
 *
 * @returns {string|null} 合法返回规范码，非法返回 null
 */
function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s\-_]/g, '').toUpperCase();
  if (cleaned.length !== ROOM_CODE_LEN) return null;
  for (const ch of cleaned) {
    if (!ROOM_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/**
 * 在 [start, start+limit) 范围内找一个能同时监听 TCP 的端口。
 *
 * 之所以要真的试监听而不是随便挑：端口被别的程序占着时，
 * 只有真正 bind 一次才知道。
 *
 * @param {number} start 起始端口
 * @param {number} limit 最多试几个
 * @returns {Promise<number>} 可用端口
 * @throws 全部占用时抛错，由调用方转成友好提示
 */
async function findFreePort(start = DEFAULT_PORT, limit = PORT_SCAN_LIMIT) {
  for (let i = 0; i < limit; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`端口 ${start}-${start + limit - 1} 都被占用，请关掉占用的程序后重试`);
}

/**
 * 检测单个端口是否空闲。
 * 监听 0.0.0.0 而不是 127.0.0.1：局域网联机需要对外可达，
 * 只测本地会漏掉「本地能起但对外不通」的情况。
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, '0.0.0.0');
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 取本机在局域网中的 IPv4 地址列表，用于在界面上直接告诉房主「让朋友连这个」。
 * 排除回环与 IPv6，按「像内网地址」优先排序。
 */
function listLocalAddresses() {
  const os = require('os');
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface: name, address: a.address });
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    if (ip.startsWith('169.254.')) return 9; // 链路本地，基本没用
    return 5;
  };
  return out.sort((a, b) => score(a.address) - score(b.address));
}

/** 取最可能可用的那个局域网地址，没有就返回 null */
function primaryLocalAddress() {
  const list = listLocalAddresses();
  return list.length ? list[0].address : null;
}

module.exports = {
  ROOM_ALPHABET,
  ROOM_CODE_LEN,
  DEFAULT_PORT,
  PORT_SCAN_LIMIT,
  makeRoomCode,
  normalizeRoomCode,
  findFreePort,
  isPortFree,
  listLocalAddresses,
  primaryLocalAddress
};
