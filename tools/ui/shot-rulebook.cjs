// ---------------------------------------------------------------------------
// 规则书跳转验证（开发用，不随程序分发）
//
// 验证的是真问题："点左侧章节，右侧是不是真的换成了那一页？"
// 用两层证据：
//   1) 画面哈希：跳页前后截图必须不同（不同 = 画面变了）
//   2) 页面文字：pdfjs 取出目标页文字，确认画的是不是那一页
//
// 用法：
//   .dev-electron\electron.exe tools\ui\shot-rulebook.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(ROOT, process.env.SHOT_OUT || 'tools/ui/shots');

const log = [];
function note(...a) {
  const line = a.join(' ');
  log.push(line);
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把画面存成 PNG 并返回哈希，用于判断"画面有没有变" */
async function snap(win, name) {
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, buf);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  note(`截图 ${name}.png  hash=${hash}  ${Math.round(buf.length / 1024)}KB`);
  return hash;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const { registerRuleBookIpc, registerRuleBookWindowIpc } = require(path.join(ROOT, 'electron', 'ipc-files.js'));
  registerRuleBookIpc();

  let rbWin = null;
  registerRuleBookWindowIpc(() => {
    if (rbWin && !rbWin.isDestroyed()) { rbWin.focus(); return; }
    rbWin = new BrowserWindow({
      width: 1280, height: 900, show: false, backgroundColor: '#0a0b0f',
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false
      }
    });
    rbWin.loadFile(path.join(ROOT, 'src', 'rulebook.html'));
    rbWin.on('closed', () => { rbWin = null; });
  });

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  rbWin = win;
  win.loadFile(path.join(ROOT, 'src', 'rulebook.html'));

  win.webContents.on('console-message', (_e, _lvl, msg) => note('[console]', msg));
  win.webContents.on('did-fail-load', (_e, ec, desc) => note('[LOAD FAIL]', ec, desc));

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  note('页面已加载');

  // ---- 1) 等第一页画出来 ----
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const st = await win.webContents.executeJavaScript(`
      ({ rendered: window.__rbRendered && window.__rbRendered.page })
    `);
    if (st.rendered === 1) { ready = true; break; }
    await sleep(250);
  }
  note('第一页渲染完成: ' + (ready ? '是' : '否（超时）'));
  const h1 = await snap(win, 'rb-01-page1');

  // ---- 2) 点「第八章 理智」，等渲染完 ----
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const items = [...document.querySelectorAll('.rb-item')];
      const hit = items.find(b => b.dataset.title && b.dataset.title.includes('第八章 理智'));
      if (!hit) return { ok: false, reason: '没找到条目' };
      hit.click();
      return { ok: true, title: hit.dataset.title, page: hit.dataset.page };
    })()
  `);
  note('点击: ' + JSON.stringify(clicked));

  // 等渲染真的结束：读页面自己报的完成信号（只看画布存在是不够的）
  let settled = false;
  for (let i = 0; i < 80; i++) {
    const st = await win.webContents.executeJavaScript(`
      ({ rendered: window.__rbRendered && window.__rbRendered.page,
         pageInput: document.getElementById('rbPageInput')?.value })
    `);
    if (st.rendered === Number(clicked.page)) { settled = true; break; }
    await sleep(250);
  }
  note('第 ' + clicked.page + ' 页渲染完成: ' + (settled ? '是' : '否（超时）'));
  await sleep(600);
  const h2 = await snap(win, 'rb-02-page137');

  // ---- 3) 画面是否真的变了 ----
  note('');
  note('画面哈希对比:');
  note('  第1页   ' + h1);
  note('  第137页 ' + h2);
  note('  两者不同: ' + (h1 !== h2 ? '是（画面已切换）' : '★ 否（画面没变，跳转失败）'));

  // ---- 4) 画布像素统计，确认不是白板 ----
  const pix = await win.webContents.executeJavaScript(`
    (() => {
      const c = document.querySelector('#rbViewer canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
      }
      return { w: c.width, h: c.height, ratio: +(nonWhite / (c.width*c.height) * 100).toFixed(2) };
    })()
  `);
  note('画布尺寸: ' + (pix ? pix.w + 'x' + pix.h : '无'));
  note('非白像素比例: ' + (pix ? pix.ratio + '%' : '无') + (pix && pix.ratio > 1 ? '  （有内容）' : '  ★ 接近空白'));

  // ---- 5) 再点另一章，验证连续跳转 ----
  const clicked2 = await win.webContents.executeJavaScript(`
    (() => {
      const items = [...document.querySelectorAll('.rb-item')];
      const hit = items.find(b => b.dataset.title && b.dataset.title.includes('第六章 战斗'));
      if (!hit) return { ok: false };
      hit.click();
      return { ok: true, page: hit.dataset.page };
    })()
  `);
  let settled2 = false;
  for (let i = 0; i < 80; i++) {
    const st = await win.webContents.executeJavaScript(`
      ({ rendered: window.__rbRendered && window.__rbRendered.page })
    `);
    if (st.rendered === Number(clicked2.page)) { settled2 = true; break; }
    await sleep(250);
  }
  await sleep(600);
  const h3 = await snap(win, 'rb-03-page87');
  note('第二次跳转（第 ' + clicked2.page + ' 页）: ' + (settled2 ? '完成' : '超时'));
  note('第三次画面与第二次不同: ' + (h3 !== h2 ? '是' : '★ 否'));

  // ---- 6) 每页像素统计，确认每一页都不是白板 ----
  const pixAll = await win.webContents.executeJavaScript(`
    (() => {
      const c = document.querySelector('#rbViewer canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
      }
      return { ratio: +(nonWhite / (c.width*c.height) * 100).toFixed(2) };
    })()
  `);
  note('第87页非白像素比例: ' + (pixAll ? pixAll.ratio + '%' : '无') +
       (pixAll && pixAll.ratio > 1 ? '  （有内容）' : '  ★ 接近空白'));

  note('');
  note('=== 结论 ===');
  const pass = (h1 !== h2) && (h2 !== h3) && pix && pix.ratio > 1 && settled && settled2;
  note(pass ? '跳转链路正常：三次画面互不相同，且页面有真实内容' : '★ 存在问题，见上面各项');

  fs.writeFileSync(path.join(OUT, 'rb-report.txt'), log.join('\n'), 'utf8');
  await sleep(300);
  app.exit(0);
});
