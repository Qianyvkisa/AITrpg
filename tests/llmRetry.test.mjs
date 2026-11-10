// ---------------------------------------------------------------------------
// chat() 重试循环 · 集成测试
//
// 这个文件测的是 electron/llm.js 里 chat() 的**真实重试行为**，
// 用假的 global.fetch 模拟上游网关，不联网。
//
// 为什么需要它：retry.test.mjs 只测了「该不该重试」的判断，
// 但真正会出事的是「重试循环本身」——比如重试了却把玩家的取消忽略了、
// 或者流式输出重试后把前半段重复推一遍。
//
// 直接 node tests/llmRetry.test.mjs
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// --- 把 electron 模块的依赖挡掉 ---------------------------------------------
// llm.js 顶部 require('electron') 取 ipcMain，node 里没有。
// 用 Module._load 拦一下，给它一个假的 ipcMain。
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { ipcMain: { handle() {}, on() {} } };
  }
  return origLoad.call(this, request, parent, isMain);
};

// config 也要挡：llm.js 会 loadConfig() 读磁盘配置
const configPath = require.resolve('../electron/config.js');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    loadConfig: () => ({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.8,
      maxTokens: 1024
    })
  }
};

const { chat } = require('../electron/llm.js');

// --- 假 fetch 工具 ----------------------------------------------------------
/** 按顺序返回预设响应，并记录每次调用 */
function mockFetch(responders) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responders[Math.min(calls.length - 1, responders.length - 1)];
    return r();
  };
  return calls;
}

function jsonResponse(status, statusText, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body ?? '',
    json: async () => JSON.parse(body ?? '{}')
  };
}

/** 构造一个返回 SSE 流的响应 */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          const data = `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`;
          return { done: false, value: encoder.encode(data) };
        }
      })
    }
  };
}

const msgs = [{ role: 'user', content: 'hi' }];
const basePayload = { messages: msgs, stream: false, requestId: 1 };

// ---------------------------------------------------------------------------
console.log('\n== 502 一次后成功：自动重试并返回内容 ==');

{
  const calls = mockFetch([
    () => jsonResponse(502, 'Bad Gateway', '<html>502</html>'),
    () => jsonResponse(200, 'OK', JSON.stringify({ choices: [{ message: { content: '成功了' } }] }))
  ]);
  const retries = [];
  const res = await chat({ ...basePayload }, { onRetry: (info) => retries.push(info) });

  eq(calls.length, 2, '发了 2 次请求（1 次失败 + 1 次重试）');
  eq(res.ok, true, '最终成功');
  eq(res.text, '成功了', '拿到内容');
  eq(res.retried, 1, '标记重试过 1 次');
  eq(retries.length, 1, '界面收到 1 次重试通知');
  eq(retries[0].attempt, 1, '通知里说明是第 1 次重试');
}

// ---------------------------------------------------------------------------
console.log('\n== 一直 502：重试到上限后给出人话 ==');

{
  const calls = mockFetch([() => jsonResponse(502, 'Bad Gateway', '<html>502</html>')]);
  const res = await chat({ ...basePayload, maxRetries: 2 }, {});

  eq(calls.length, 3, '总共请求 3 次（首次 + 2 次重试）');
  eq(res.ok, false, '最终失败');
  ok(res.friendly, '带有 friendly 说明');
  ok(res.friendly.includes('暂时不可用'), 'friendly 是「暂时不可用」这类人话');
  ok(!res.friendly.includes('<html>'), 'friendly 里没有 HTML');
  eq(res.retried, 2, '记录重试了 2 次');
}

// ---------------------------------------------------------------------------
console.log('\n== 401 密钥错：不重试，立刻失败 ==');

{
  const calls = mockFetch([() => jsonResponse(401, 'Unauthorized', 'bad key')]);
  const res = await chat({ ...basePayload, maxRetries: 2 }, {});

  eq(calls.length, 1, '只请求 1 次（配置错误重试没用）');
  eq(res.ok, false, '失败');
  ok(res.friendly.includes('API Key'), '文案指出是 Key 的问题');
}

// ---------------------------------------------------------------------------
console.log('\n== 玩家取消：不重试 ==');

{
  const calls = mockFetch([() => jsonResponse(502, 'Bad Gateway', '')]);
  // 先发起，再取消
  const p = chat({ ...basePayload, maxRetries: 2, requestId: 99 }, {});
  // 立刻取消（此时可能还在首次请求中或刚失败）
  const { cancel } = require('../electron/llm.js');
  setTimeout(() => cancel(99), 0);
  const res = await p;

  eq(res.ok, false, '取消后失败');
  ok(calls.length <= 2, `取消后没有继续重试到底（实际请求 ${calls.length} 次）`);
}

// ---------------------------------------------------------------------------
console.log('\n== 流式成功：正常拼接 ==');

{
  const calls = mockFetch([() => sseResponse(['你好', '，', '世界'])]);
  const chunks = [];
  const res = await chat(
    { messages: msgs, stream: true, requestId: 2 },
    { onChunk: (d) => chunks.push(d.delta) }
  );

  eq(calls.length, 1, '流式成功只请求 1 次');
  eq(res.ok, true, '成功');
  eq(res.text, '你好，世界', '内容完整拼接');
  eq(chunks.join(''), '你好，世界', 'onChunk 收到全部增量');
}

// ---------------------------------------------------------------------------
console.log('\n== 流式失败（还没推任何内容）：允许重试 ==');

{
  const calls = mockFetch([
    () => jsonResponse(503, 'Service Unavailable', ''),
    () => sseResponse(['恢复', '了'])
  ]);
  const res = await chat({ messages: msgs, stream: true, requestId: 3 }, {});

  eq(calls.length, 2, '503 后重试了 1 次');
  eq(res.ok, true, '重试成功');
  eq(res.text, '恢复了', '拿到完整内容');
}

// ---------------------------------------------------------------------------
console.log('\n== maxRetries=0：完全不重试 ==');

{
  const calls = mockFetch([() => jsonResponse(502, 'Bad Gateway', '')]);
  const res = await chat({ ...basePayload, maxRetries: 0 }, {});

  eq(calls.length, 1, '只请求 1 次');
  eq(res.ok, false, '失败');
}

// ---------------------------------------------------------------------------
console.log('\n== 网络异常：可重试 ==');

{
  const calls = mockFetch([
    () => { throw new Error('fetch failed'); },
    () => jsonResponse(200, 'OK', JSON.stringify({ choices: [{ message: { content: '好了' } }] }))
  ]);
  const res = await chat({ ...basePayload }, {});

  eq(calls.length, 2, '网络异常后重试了 1 次');
  eq(res.ok, true, '重试成功');
  eq(res.text, '好了', '拿到内容');
}

// ---------------------------------------------------------------------------
console.log('\n==========================================');
if (failed === 0) {
  console.log(`通过 ${passed} 项，全部通过`);
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
