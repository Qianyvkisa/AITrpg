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

/** 进行中的请求：requestId → AbortController */
const inflight = new Map();

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

  const headers = { 'Content-Type': 'application/json' };
  if (target.key) headers.Authorization = `Bearer ${target.key}`;

  const body = JSON.stringify({
    model: target.model,
    messages: payload.messages,
    temperature: target.temperature ?? 0.8,
    max_tokens: payload.maxTokens ?? cfg.maxTokens ?? 2048,
    stream
  });

  const controller = new AbortController();
  if (requestId !== undefined && requestId !== null) inflight.set(requestId, controller);

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
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}\n${detail}` };
    }

    if (!stream) {
      const data = await res.json();
      return { ok: true, text: data?.choices?.[0]?.message?.content ?? '' };
    }

    return { ok: true, text: await readStream(res, requestId, hooks.onChunk) };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, canceled: true, error: '请求已取消' };
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
  const controller = inflight.get(requestId);
  if (!controller) return false;
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
      }
    })
  );

  ipcMain.handle('llm:cancel', (_e, requestId) => cancel(requestId));

  // 设置界面「获取模型」用
  ipcMain.handle('llm:models', (_e, payload) => listModels(payload || {}));
}

module.exports = { chat, cancel, listModels, registerLlmIpc };
