// ---------------------------------------------------------------------------
// 用 CDP 给四套主题各截一张图，确认视觉效果真的不一样
// 用法：先带 --remote-debugging-port=9222 启动，再 node tools/cdp-shot-themes.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const PORT = 9222;
const OUT = 'D:\\Tool\\AIrpg\\shots';

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('没找到 page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  }
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res2, rej) => {
    pending.set(mid, { resolve: res2, reject: rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const themes = [
  ['brass', '黄铜档案'],
  ['abyss', '深海幽蓝'],
  ['phosphor', '磷光终端'],
  ['blood', '血月绯红'],
];

for (const [id_, name] of themes) {
  await evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(id_)}; })()`);
  await new Promise((r) => setTimeout(r, 450));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `theme-${id_}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`${name}  →  ${file}`);
}

await evaluate(`(() => { document.documentElement.dataset.theme = 'brass'; })()`);
ws.close();
console.log('\n四套主题截图完成');
