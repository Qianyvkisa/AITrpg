'use strict';

// ---------------------------------------------------------------------------
// LLM 调用：OpenAI 兼容 /chat/completions，支持流式
// ---------------------------------------------------------------------------
const { ipcMain } = require('electron');
const { loadConfig } = require('./config');
const {
  resolveTarget,
  buildEndpoint,
  buildModelsEndpoint,
  normalizeModels,
  isLocalEndpoint
} = require('./defaults');
const { createSseDecoder } = require('./sse');
const {
  DEFAULT_MAX_RETRIES,
  isRetryable,
  backoffDelay,
  describeFailure
} = require('./retry');

/** 进行中的请求：requestId → AbortController */
const inflight = new Map();

/**
 * 被玩家取消过的 requestId。
 *
 * 为什么不能只靠 inflight 判断：每次尝试结束（成功/失败）都会把 id 从 inflight
 * 里删掉，所以「不在 inflight 里」既可能是「刚跑完」也可能是「被取消」。
 * 重试循环要区分这两种情况，否则玩家点了取消，重试还会继续发请求。
 *
 * 用一个独立的集合记录，请求彻底结束（成功返回或不再重试）时清掉。
 */
const canceled = new Set();

/**
 * 拉取可用模型列表（GET /models）。
 * 只用于设置界面的模型下拉，不参与对话。
 * @param payload { baseUrl?, apiKey? } 不传则用已保存的配置
 * @returns { ok, models?: [{id, ownedBy}], error? }
 */
async function listModels(payload = {}) {
  const cfg = loadConfig();
  const url = payload.baseUrl || cfg.baseUrl || '';
  const key = payload.apiKey || cfg.apiKey || '';

  if (!url) return { ok: false, error: '请先填写 API 地址' };
  if (!key && !isLocalEndpoint(url)) return { ok: false, error: '请先填写 API Key' };

  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  const controller = new AbortController();
  // 避免地址不可达时界面一直转圈
  const timer = setTimeout(() => {
    try { controller.abort(); } catch (_) { /* ignore */ }
  }, 15000);

  try {
    const res = await fetch(buildModelsEndpoint(url), {
      method: 'GET',
      headers,
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}${detail ? '\n' + detail : ''}` };
    }

    const json = await res.json();
    const models = normalizeModels(json);
    if (!models.length) {
      return { ok: false, error: '接口返回了空的模型列表' };
    }
    return { ok: true, models };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, error: '请求超时或已取消' };
    }
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发起一次对话请求。
 * @param payload { messages, purpose, requestId, stream, temperature, maxTokens, ... }
 * @param hooks   { onChunk({ requestId, delta }) }
 * @returns { ok, text, error?, canceled? }
 */
async function chat(payload, hooks = {}) {
  const cfg = loadConfig();
  const target = resolveTarget(cfg, payload);

  if (!target.model) return { ok: false, error: '未配置模型名称' };
  if (!target.key && !isLocalEndpoint(target.url)) return { ok: false, error: '未配置 API Key' };
  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    return { ok: false, error: '请求缺少 messages' };
  }

  const stream = payload.stream !== false;
  const requestId = payload.requestId;
  const hasId = requestId !== undefined && requestId !== null;

  // 清掉可能残留的取消标记（同一个 requestId 理论上不会复用，但别留脏数据）
  if (hasId) canceled.delete(requestId);

  // 重试次数：调用方可以指定，默认 2 次（总共最多请求 3 次）
  const maxRetries = Number.isFinite(payload.maxRetries)
    ? Math.max(0, Math.floor(payload.maxRetries))
    : DEFAULT_MAX_RETRIES;

  // 玩家是否已经取消。优先用内部的 canceled 集合（可靠），
  // 也兼容调用方注入的 isCanceled（测试或别的宿主用）。
  const isCanceled = () => (hasId && canceled.has(requestId)) || !!hooks.isCanceled?.();

  let lastRes = null;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 重试前先等一会儿（首次不等待）。用可取消的等待，
      // 否则玩家点了取消还要被这一段退避拖住。
      if (attempt > 0) {
        const wait = backoffDelay(attempt);
        hooks.onRetry?.({ attempt, maxRetries, delayMs: wait, error: lastRes?.error });
        const ok = await sleep(wait, isCanceled);
        if (!ok) return { ok: false, canceled: true, error: '请求已取消' };
      }

      lastRes = await attemptOnce(payload, {
        target, stream, requestId, hooks
      });

      if (lastRes.ok) {
        // 重试过就记一笔，方便排查「偶尔卡一下」的情况
        if (attempt > 0) lastRes.retried = attempt;
        return lastRes;
      }

      // 玩家主动取消：立刻返回，绝不重试
      if (lastRes.canceled) return lastRes;

      // 不值得重试的错误（密钥错、模型名错等）立刻返回，别浪费玩家时间。
      // 但同样要附上「人话」说明——401 这类恰恰是最需要告诉玩家去改哪里的。
      if (!isRetryable(lastRes)) {
        if (attempt > 0) lastRes.retried = attempt;
        lastRes.friendly = describeFailure(lastRes, attempt);
        return lastRes;
      }

      // 退避等待前再看一眼：玩家可能在这几毫秒里点了取消
      if (isCanceled()) return { ok: false, canceled: true, error: '请求已取消' };

      // 最后一次也失败了：给一句人话，别把上游那页 HTML 直接糊到界面
      if (attempt === maxRetries) {
        lastRes.retried = attempt;
        lastRes.friendly = describeFailure(lastRes, attempt);
        return lastRes;
      }
    }

    // 兜底：理论上走不到这里（循环内每个分支都 return 了），
    // 但万一将来改了循环结构，也要保证失败结果一定带 friendly。
    if (lastRes && !lastRes.ok && !lastRes.canceled && !lastRes.friendly) {
      lastRes.friendly = describeFailure(lastRes, lastRes.retried || 0);
    }
    return lastRes;
  } finally {
    // 请求彻底结束，清掉取消标记，避免 canceled 集合无限增长
    if (hasId) canceled.delete(requestId);
  }
}

/**
 * 可取消的等待。
 * @returns {Promise<boolean>} false = 等待期间被取消了
 */
function sleep(ms, isCanceled) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    // 每 100ms 检查一次取消标记，避免玩家点了取消还要干等
    const iv = setInterval(() => {
      if (isCanceled?.()) {
        clearTimeout(t);
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
    // 正常结束时清掉轮询
    setTimeout(() => clearInterval(iv), ms + 50);
  });
}

/**
 * 发起一次请求（不含重试）。
 * 抽出来是为了让 chat() 的重试循环干净，也让「流式只能试一次」的约束集中在这里。
 */
async function attemptOnce(payload, { target, stream, requestId, hooks }) {
  const headers = { 'Content-Type': 'application/json' };
  if (target.key) headers.Authorization = `Bearer ${target.key}`;

  const body = JSON.stringify({
    model: target.model,
    messages: payload.messages,
    temperature: target.temperature ?? 0.8,
    max_tokens: payload.maxTokens ?? loadConfig().maxTokens ?? 2048,
    stream
  });

  const controller = new AbortController();
  if (requestId !== undefined && requestId !== null) inflight.set(requestId, controller);

  // 是否已经往外推过内容。流式一旦推过 chunk 就不能重试，
  // 否则重试会把前半段重复推一遍，界面上出现两截拼接的乱码。
  let pushed = false;

  try {
    const res = await fetch(buildEndpoint(target.url), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 800); } catch (_) { /* ignore */ }
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status} ${res.statusText}\n${detail}`
      };
    }

    if (!stream) {
      const data = await res.json();
      return { ok: true, text: data?.choices?.[0]?.message?.content ?? '' };
    }

    const wrapped = (data) => {
      pushed = true;
      hooks.onChunk?.(data);
    };

    const text = await readStream(res, requestId, wrapped);
    return { ok: true, text };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, canceled: true, error: '请求已取消' };
    // 已经推过内容的中断不能重试（会把界面上那半截重复写一遍），
    // 标记成 canceled 让上层当作「已取消」处理，不再重试。
    if (pushed) return { ok: false, canceled: true, error: '流式输出中断' };
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (requestId !== undefined && requestId !== null) inflight.delete(requestId);
  }
}

/** 逐块读取 SSE 流，边解析边通过 onChunk 推送增量 */
async function readStream(res, requestId, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = createSseDecoder();
  let full = '';

  const handle = (payloads) => {
    for (const data of payloads) {
      if (data === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(data); } catch (_) { continue; }  // 不完整分片，忽略
      const delta = obj?.choices?.[0]?.delta?.content;
      if (!delta) continue;
      full += delta;
      onChunk?.({ requestId, delta });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    handle(sse.push(decoder.decode(value, { stream: true })));
  }
  handle(sse.flush());

  return full;
}

function cancel(requestId) {
  if (requestId === undefined || requestId === null) return false;

  // 先记下取消标记：即使此刻没有 controller（比如正卡在重试退避里），
  // 重试循环也能看到「玩家不要了」，从而立刻收手。
  canceled.add(requestId);

  const controller = inflight.get(requestId);
  if (!controller) {
    // 没有进行中的连接，但可能正在退避等待——标记已经打上，等待会中断
    return true;
  }
  try { controller.abort(); } catch (_) { /* ignore */ }
  inflight.delete(requestId);
  return true;
}

/** 注册 llm:* 的 IPC，chunk 事件通过 getWindow 取到的窗口推给渲染层 */
function registerLlmIpc(getWindow) {
  ipcMain.handle('llm:chat', (_e, payload) =>
    chat(payload, {
      onChunk: (data) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('llm:chunk', data);
      },
      // 重试时通知界面，否则玩家会盯着一个「卡住」的界面不知道发生了什么
      onRetry: (info) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('llm:retry', { requestId: payload?.requestId, ...info });
        }
      }
    })
  );

  ipcMain.handle('llm:cancel', (_e, requestId) => cancel(requestId));

  // 设置界面「获取模型」用
  ipcMain.handle('llm:models', (_e, payload) => listModels(payload || {}));
}

module.exports = { chat, cancel, listModels, registerLlmIpc };
