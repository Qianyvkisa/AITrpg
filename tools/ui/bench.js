// ---------------------------------------------------------------------------
// 流式渲染性能基准（开发用，不随程序分发）
//
// 目的：把「界面卡顿」这类主观感受换成可核对的数字。验证两点：
//   1) 流式 chunk 到达 N 次时，DOM 真正被写入的次数是不是被合帧压到
//      「每帧最多一次」，而不是每来一个 chunk 就写一次
//   2) 一次性渲染大量历史消息的耗时是否在可接受范围
//
// 用法：浏览器打开 tools/ui/bench.html?chunks=2000
//      结果打印在页面上，同时写进 <pre id="benchReport"> 供 --dump-dom 抓取
// ---------------------------------------------------------------------------
import {
  renderAllMessages,
  renderMessage,
  scheduleStreamUpdate,
  endStreamingBubble
} from '../../src/ui/messages.js';

const params = new URLSearchParams(location.search);
const CHUNKS = Number(params.get('chunks') || 2000);
const FRAMES = Number(params.get('frames') || 60);

const results = {};

// 造一个和引擎里结构一致的消息对象
function makeStreamingMsg(id) {
  return { id, role: 'keeper', text: '', streaming: true, clean: undefined };
}

async function run() {
  // ---- 准备容器 ----
  const host = document.createElement('div');
  host.id = 'messages';
  host.className = 'messages';
  host.style.cssText = 'height:400px;overflow-y:auto;';
  document.body.appendChild(host);

  // ---- 用例 1：流式合帧 ----
  // 每条流式消息先插入气泡，再喂 CHUNKS 次增量更新，
  // 用 MutationObserver 记录气泡文本真正被改写的次数。
  const msg = makeStreamingMsg('bench-stream');
  renderMessage(msg);

  const bubble = host.querySelector('[data-msg-id="bench-stream"] .bubble');
  let domWrites = 0;
  const mo = new MutationObserver((records) => {
    domWrites += records.length;
  });
  mo.observe(bubble, { childList: true, characterData: true, subtree: true });

  const t0 = performance.now();
  // 模拟 AI 流式返回：把一段长文本切成 CHUNKS 个碎片。
  // 关键是要跨帧分发——如果同步一口气喂完，所有 chunk 都落在同一帧，
  // 合帧后自然只有 1 次写入，测出来的比值没有意义。
  // 这里每 CHUNKS_PER_FRAME 个碎片让出一帧，模拟真实到达节奏。
  const unit = '雨声从窗缝里钻进来，纸页在灯下泛着旧黄。';
  const full = unit.repeat(Math.ceil(CHUNKS / unit.length));
  const perFrame = Number(params.get('perFrame') || 20);
  // 让出帧的方式：默认用定时器（虚拟时间下 rAF 不一定推进，
  // 用定时器能保证每次让出都跨到一个新的渲染帧）。
  const yieldMode = params.get('yield') || 'timer';
  const yieldFrame = () =>
    new Promise((r) => {
      if (yieldMode === 'raf') requestAnimationFrame(() => r());
      else setTimeout(r, 16);
    });

  for (let i = 1; i <= CHUNKS; i++) {
    msg.text = full.slice(0, i);
    scheduleStreamUpdate(msg);
    if (i % perFrame === 0) {
      await yieldFrame();
    }
  }
  endStreamingBubble('bench-stream');
  // 等几帧，让所有 rAF 回调落地
  await new Promise((r) => setTimeout(r, 250));
  const tStream = performance.now() - t0;
  mo.disconnect();

  const framesUsed = Math.ceil(CHUNKS / perFrame);
  results.streaming = {
    chunks: CHUNKS,
    perFrame,
    framesUsed,
    domWrites,
    // 合帧生效时，写入次数应接近「帧数」而不是「chunk 数」
    writesPerChunk: +(domWrites / CHUNKS).toFixed(4),
    writesPerFrame: +(domWrites / framesUsed).toFixed(2),
    ms: Math.round(tStream),
    coalesced: domWrites < CHUNKS
  };

  // 合帧的正确性结论来自代码路径（pending 去重 + rAF 单次调度），
  // 不依赖这里的数字。但「写入次数」会被 rAF 节流影响，所以标注可信度：
  // 如果 domWrites 少得离谱（比如 2000 chunk 只写 3 次），说明 rAF 被饿死
  // （headless 的 --virtual-time-budget、隐藏窗口、后台标签都会这样），
  // 这个数字不能当作「合帧效果好」的证据。
  const rAFHealthy = domWrites >= framesUsed * 0.5;
  results.streaming.rAFHealthy = rAFHealthy;
  results.streaming.trustworthy = rAFHealthy;
  if (!rAFHealthy) {
    results.streaming.note =
      'rAF 未被正常调度（写入次数远低于帧数），此处的耗时/写入数字不可信；' +
      '请在真实显示窗口里跑 tools/ui/bench-main.cjs 获取有效数据。';
  }

  // ---- 用例 2：一次性渲染大量历史消息 ----
  host.innerHTML = '';
  const N = Number(params.get('history') || 300);
  const history = [];
  for (let i = 0; i < N; i++) {
    history.push({
      id: `h${i}`,
      role: i % 3 === 0 ? 'user' : 'keeper',
      text: `第 ${i} 条记录。` + unit.repeat(3)
    });
  }
  const t1 = performance.now();
  renderAllMessages(history);
  const tHistory = performance.now() - t1;

  results.history = {
    count: N,
    ms: Math.round(tHistory),
    perMsgMs: +(tHistory / N).toFixed(3)
  };

  // ---- 用例 3：滚动到底部是否不触发平滑动画 ----
  // scroll-behavior:smooth 会让流式时的每帧 scrollTop 赋值互相打断，
  // 表现是滚动抖动 + 掉帧，这里核对实际计算样式。
  results.scroll = {
    behavior: getComputedStyle(host).scrollBehavior || 'auto'
  };

  report();
}

function report() {
  const out = document.createElement('pre');
  out.id = 'benchReport';
  out.textContent = JSON.stringify(results, null, 2);
  document.body.appendChild(out);
  console.log(JSON.stringify(results));
}

run().catch((e) => {
  results.error = String(e && e.stack ? e.stack : e);
  report();
});
