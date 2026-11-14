'use strict';

// ---------------------------------------------------------------------------
// 联机协议：消息类型、版本、校验
//
// 这一层是纯逻辑，不碰 socket、不碰 electron，node 里可以直接 import 测试。
// 所有网络消息都必须先过 parse()，非法输入一律拒绝——网络边界上不能信任
// 任何字节，对方可能是旧版本、可能被改过、也可能只是发错。
// ---------------------------------------------------------------------------

/** 协议版本。不兼容的改动必须 +1，否则老客户端会静默错乱 */
const PROTOCOL_VERSION = 1;

/** 客户端 → 房主 */
const C2H = {
  HELLO: 'hello',    // 打招呼，申请加入
  CLAIM: 'claim',    // 认领一位调查员
  ACTION: 'action',  // 本回合行动
  ROLL: 'roll',      // 掷自己的骰
  CHAT: 'chat',      // 场外聊天，不进 KP 上下文
  READY: 'ready',    // 准备好进入下一轮
  PING: 'ping'
};

/** 房主 → 客户端 */
const H2C = {
  WELCOME: 'welcome',  // 加入/重连成功，带全量快照
  PATCH: 'patch',      // 增量同步
  STREAM: 'stream',    // 流式正文
  PENDING: 'pending',  // 待掷骰列表
  PLAYERS: 'players',  // 玩家列表
  TURN: 'turn',        // 回合阶段
  ERROR: 'error',
  PONG: 'pong',
  HOST_GONE: 'host-gone'
};

/** 单条消息的大小上限：正常消息远小于这个数，超过就是异常或攻击 */
const MAX_MESSAGE_BYTES = 256 * 1024;

/** 名字长度上限，避免有人在名字里塞一整篇文章 */
const MAX_NAME_LEN = 24;

/** 行动文本上限，超长会直接撑爆 LLM 上下文 */
const MAX_ACTION_LEN = 2000;

/** 场外聊天上限 */
const MAX_CHAT_LEN = 500;

/**
 * 解析并校验一条来自网络的原始消息。
 *
 * @param {string|Buffer} raw socket 收到的原始数据
 * @returns {{ok: true, msg: object} | {ok: false, error: string}}
 */
function parse(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, error: '空消息' };
  }

  // Buffer 也要按字节数卡上限：先看长度再解码，避免超大 payload 先吃内存
  const byteLen = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw), 'utf8');
  if (byteLen > MAX_MESSAGE_BYTES) {
    return { ok: false, error: `消息过大（${byteLen} 字节）` };
  }

  let obj;
  try {
    obj = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch (e) {
    return { ok: false, error: '不是合法 JSON' };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '消息必须是对象' };
  }
  if (typeof obj.t !== 'string' || !obj.t) {
    return { ok: false, error: '缺少消息类型 t' };
  }

  const known = new Set([...Object.values(C2H), ...Object.values(H2C)]);
  if (!known.has(obj.t)) {
    return { ok: false, error: `未知消息类型 ${obj.t}` };
  }

  return { ok: true, msg: obj };
}

/** 序列化一条消息。失败返回 null（循环引用等），调用方负责跳过 */
function encode(type, payload = {}) {
  try {
    return JSON.stringify({ ...payload, t: type });
  } catch (e) {
    return null;
  }
}

/** 截断字符串到指定长度，非字符串按空串处理 */
function clampText(v, maxLen) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * 校验并规范化 hello 消息。
 * 版本不一致要明确拒绝——让两端协议对不上时表现为「连不上」，
 * 而不是「连上了但行为诡异」。
 */
function validateHello(msg) {
  if (!msg || msg.t !== C2H.HELLO) return { ok: false, error: '不是 hello 消息' };

  const version = Number(msg.version);
  if (!Number.isInteger(version)) {
    return { ok: false, error: '缺少协议版本' };
  }
  if (version !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `版本不一致：对方 v${version}，本机 v${PROTOCOL_VERSION}。请双方使用同一版本的程序。`
    };
  }

  const name = clampText(msg.name, MAX_NAME_LEN);
  if (!name) return { ok: false, error: '缺少玩家名字' };

  // token 只在重连时出现，允许为空
  const token = typeof msg.token === 'string' && msg.token ? msg.token : null;

  return { ok: true, value: { version, name, token } };
}

/** 校验 claim：需要角色 id */
function validateClaim(msg) {
  if (!msg || msg.t !== C2H.CLAIM) return { ok: false, error: '不是 claim 消息' };
  const charId = clampText(msg.charId, 64);
  if (!charId) return { ok: false, error: '缺少角色 id' };
  return { ok: true, value: { charId } };
}

/** 校验 action：需要非空文本 */
function validateAction(msg) {
  if (!msg || msg.t !== C2H.ACTION) return { ok: false, error: '不是 action 消息' };
  const text = clampText(msg.text, MAX_ACTION_LEN);
  if (!text) return { ok: false, error: '行动内容为空' };
  return { ok: true, value: { text } };
}

/** 校验 roll：需要待掷骰 id */
function validateRoll(msg) {
  if (!msg || msg.t !== C2H.ROLL) return { ok: false, error: '不是 roll 消息' };
  const pendingId = clampText(msg.pendingId, 64);
  if (!pendingId) return { ok: false, error: '缺少掷骰 id' };
  return { ok: true, value: { pendingId } };
}

/** 校验 chat */
function validateChat(msg) {
  if (!msg || msg.t !== C2H.CHAT) return { ok: false, error: '不是 chat 消息' };
  const text = clampText(msg.text, MAX_CHAT_LEN);
  if (!text) return { ok: false, error: '聊天内容为空' };
  return { ok: true, value: { text } };
}

module.exports = {
  PROTOCOL_VERSION,
  C2H,
  H2C,
  MAX_MESSAGE_BYTES,
  MAX_NAME_LEN,
  MAX_ACTION_LEN,
  MAX_CHAT_LEN,
  parse,
  encode,
  clampText,
  validateHello,
  validateClaim,
  validateAction,
  validateRoll,
  validateChat
};
