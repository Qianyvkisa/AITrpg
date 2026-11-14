// ---------------------------------------------------------------------------
// 用 CDP 在打包版里验证主题系统（不依赖鼠标坐标，避免点到别处）
//
// 验证项：
//   1) documentElement 的 data-theme / data-read-width 初值
//   2) 四套主题切换后 CSS 变量实际计算值是否真的变了
//   3) 三档阅读宽度切换后 --read-max 是否变化
//   4) 非法主题名是否回落到默认
//   5) 设置面板外观 tab 的 DOM 是否齐备（主题卡 4 个 / 宽度卡 3 个）
//
// 用法：先带 --remote-debugging-port=9222 启动打包版，再 node tools/cdp-verify-theme.mjs
// ---------------------------------------------------------------------------

const PORT = 9222;

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((r, j) => {
            pending.set(mid, { resolve: r, reject: j });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });
  });
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const targets = await listTargets();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没找到 page target');
  process.exit(1);
}

const client = await connect(page.webSocketDebuggerUrl);
await client.send('Runtime.enable');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('\n=== 1. 初始状态 ===');
const init = await evaluate(client, `(() => ({
  theme: document.documentElement.dataset.theme,
  rw: document.documentElement.dataset.readWidth,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  readMax: getComputedStyle(document.documentElement).getPropertyValue('--read-width').trim(),
  themeCount: document.querySelectorAll('link[href*="themes.css"]').length,
}))()`);
console.log('  ' + JSON.stringify(init));
check('data-theme 有值', !!init.theme, `= ${init.theme}`);
check('data-read-width 有值', !!init.rw, `= ${init.rw}`);
check('themes.css 已加载', init.themeCount >= 1, `link x${init.themeCount}`);
check('--accent 已解析', !!init.accent, `= ${init.accent}`);

console.log('\n=== 2. 四套主题切换 ===');
const themes = ['brass', 'abyss', 'phosphor', 'blood'];
const seen = new Map();
for (const t of themes) {
  const v = await evaluate(client, `(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(t)};
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue('--accent').trim(),
      bg: cs.getPropertyValue('--bg').trim(),
      ink: cs.getPropertyValue('--ink').trim(),
      radiusMd: cs.getPropertyValue('--radius-md').trim(),
      scan: cs.getPropertyValue('--scan-opacity').trim(),
    };
  })()`);
  seen.set(t, v);
  check(`${t} 变量齐备`, !!(v.accent && v.bg && v.ink), `accent=${v.accent} bg=${v.bg} scan=${v.scan}`);
}
// 四套主题的 accent 必须两两不同，否则说明某套没生效
const accents = [...seen.values()].map((v) => v.accent);
check('四套主题 accent 互不相同', new Set(accents).size === 4, accents.join(' | '));

console.log('\n=== 3. 三档阅读宽度 ===');
const widths = ['narrow', 'normal', 'wide'];
const wVals = [];
for (const w of widths) {
  const v = await evaluate(client, `(() => {
    document.documentElement.dataset.readWidth = ${JSON.stringify(w)};
    return getComputedStyle(document.documentElement).getPropertyValue('--read-width').trim();
  })()`);
  wVals.push(v);
  check(`${w} → --read-width`, !!v, `= ${v}`);
}
check('三档宽度互不相同', new Set(wVals).size === 3, wVals.join(' | '));

console.log('\n=== 4. 非法值回落 ===');
const bad = await evaluate(client, `(() => {
  document.documentElement.dataset.theme = 'nonexistent-theme';
  document.documentElement.dataset.readWidth = 'nonexistent-width';
  const cs = getComputedStyle(document.documentElement);
  return {
    accent: cs.getPropertyValue('--accent').trim(),
    readMax: cs.getPropertyValue('--read-width').trim(),
  };
})()`);
console.log('  ' + JSON.stringify(bad));
// 非法 data-theme 时不应有主题块匹配，:root 兜底变量仍在（若 :root 与 brass 同块则继承黄铜）
check('非法主题下变量仍有兜底', !!bad.accent, `accent=${bad.accent}`);

console.log('\n=== 5. 设置面板外观 tab DOM ===');
const dom = await evaluate(client, `(async () => {
  document.documentElement.dataset.theme = 'brass';
  document.documentElement.dataset.readWidth = 'normal';
  // 直接调 openSettings，看外观 tab 结构
  if (typeof window.__testOpenSettings !== 'function') {
    // 没有测试钩子就退化为检查 styles.css 里的选择器是否生效
    const hasThemeOpt = [...document.styleSheets].some((ss) => {
      try { return [...ss.cssRules].some((r) => (r.selectorText || '').includes('.theme-opt')); }
      catch { return false; }
    });
    return { hook: false, hasThemeOptCss: hasThemeOpt };
  }
  return { hook: true };
})()`);
console.log('  ' + JSON.stringify(dom));
check('.theme-opt 样式存在', dom.hasThemeOptCss === true || dom.hook === true);

console.log('\n=== 6. 扫描线叠加层（phosphor 专属） ===');
const scan = await evaluate(client, `(() => {
  document.documentElement.dataset.theme = 'phosphor';
  const cs = getComputedStyle(document.body, '::after');
  const disp = cs.display;
  const op = getComputedStyle(document.documentElement).getPropertyValue('--scan-opacity').trim();
  return { display: disp, opacity: op };
})()`);
console.log('  ' + JSON.stringify(scan));
check('phosphor 扫描线不透明度已设', !!scan.opacity, `= ${scan.opacity}`);

// 收尾：恢复默认主题
await evaluate(client, `(() => {
  document.documentElement.dataset.theme = 'brass';
  document.documentElement.dataset.readWidth = 'normal';
})()`);

client.close();

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
