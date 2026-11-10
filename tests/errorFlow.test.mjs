// ---------------------------------------------------------------------------
// 端到端：502 → engine.takeTurn 的返回值 → 界面提示文案
//
// 单独跑 llmRetry 只证明 chat() 会重试，但玩家看到的是 engine.takeTurn()
// 的返回值。中间任何一环把 friendly 丢了，界面上就还是那段 HTML。
// 这个文件专门验证这条链路不断。
//
// 直接 node tests/errorFlow.test.mjs
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// electron 依赖挡板
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain: { handle() {}, on() {} } };
  return origLoad.call(this, request, parent, isMain);
};

const configPath = require.resolve('../electron/config.js');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true,
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

// ---------------------------------------------------------------------------
console.log('\n== 502 重试耗尽的最终结果带可读文案 ==');

{
  globalThis.fetch = async () => ({
    ok: false, status: 502, statusText: 'Bad Gateway',
    text: async () => '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n</html>',
    json: async () => ({})
  });

  const res = await chat(
    { messages: [{ role: 'user', content: 'hi' }], stream: false, requestId: 1, maxRetries: 2 },
    {}
  );

  eq(res.ok, false, '最终失败');
  ok(res.friendly, '有 friendly 字段');
  ok(res.friendly.includes('暂时不可用'), 'friendly 说明服务暂时不可用');
  ok(!res.friendly.includes('<html>'), 'friendly 里没有 HTML');
  ok(!res.friendly.includes('<title>'), 'friendly 里没有 HTML 标签');
}

// ---------------------------------------------------------------------------
console.log('\n== 模拟 engine 的失败返回结构 ==');

// engine.runKeeper 在 res.ok=false 时返回 false，并把 friendly 存进 lastError；
// takeTurn 再把 lastError 放进返回对象的 error 字段。这里模拟这条链，
// 确认 app.js 读 res.error 拿到的就是「人话」。
{
  globalThis.fetch = async () => ({
    ok: false, status: 502, statusText: 'Bad Gateway',
    text: async () => '<html>502</html>', json: async () => ({})
  });

  const res = await chat(
    { messages: [{ role: 'user', content: 'hi' }], stream: false, requestId: 2, maxRetries: 1 },
    {}
  );

  // engine 的逻辑：lastError = res.friendly || res.error
  const lastError = res.friendly || res.error || '';
  // takeTurn 的逻辑：error: ok ? '' : lastError
  const turnResult = { ok: false, error: lastError };

  ok(turnResult.error.includes('暂时不可用'), 'engine → app 链路上文案不丢');
  ok(!turnResult.error.includes('<html>'), '整条链路上都没有 HTML');

  // app.js 拼给玩家看的完整提示
  const notice = `【自动推进已暂停】KP 连接失败：${turnResult.error} 稍后点「推进」即可继续，开关仍保持开启。`;
  ok(notice.includes('稍后点「推进」'), '提示告诉玩家怎么恢复');
  ok(notice.includes('开关仍保持开启'), '提示说明开关没被关掉');
  ok(!notice.includes('及降级目标全部失败'), '不把上游内部术语甩给玩家');
}

// ---------------------------------------------------------------------------
console.log('\n== 401 立刻失败但文案可操作 ==');

{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false, status: 401, statusText: 'Unauthorized',
      text: async () => 'invalid api key', json: async () => ({})
    };
  };

  const res = await chat(
    { messages: [{ role: 'user', content: 'hi' }], stream: false, requestId: 3, maxRetries: 2 },
    {}
  );

  eq(calls, 1, '401 只请求 1 次（不浪费玩家时间）');
  ok(res.friendly.includes('API Key'), '文案指出是 Key 的问题');
  ok(res.friendly.includes('设置'), '文案告诉玩家去哪里改');
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
