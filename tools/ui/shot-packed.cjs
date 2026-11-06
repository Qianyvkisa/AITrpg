// ---------------------------------------------------------------------------
// 打包产物端到端验证（开发用）
//
// 为什么要在打包产物上再验一遍：
//   开发目录里 src/vendor 和 assets 都在磁盘上，一切好办；
//   但打包后代码进了 app.asar，PDF 在 app.asar.unpacked 里。
//   pdfjs 要读 cMap（在 asar 内）和 PDF 字节（在 asar 外），
//   这两条路径只有真正跑过打包产物才能确认没断。
//
// 用法：.dev-electron\electron.exe tools\ui\shot-packed.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKED = path.join(ROOT, 'dist', 'win-unpacked', 'resources');
const OUT = path.join(ROOT, 'tools', 'ui', 'shots');
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 关键：加载 asar 里的 index，而不是磁盘上的 src
  const asarIndex = path.join(PACKED, 'app.asar', 'src', 'rulebook.html');
  note('目标页面: ' + asarIndex);
  note('asar 存在: ' + fs.existsSync(path.join(PACKED, 'app.asar')));
  note('PDF 解包存在: ' + fs.existsSync(path.join(PACKED, 'app.asar.unpacked', 'assets', 'coc-kp.pdf')));

  // 注册 asar 里的 IPC（走打包后那份代码）
  const { registerRuleBookIpc } = require(path.join(PACKED, 'app.asar', 'electron', 'ipc-files.js'));
  registerRuleBookIpc();

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(PACKED, 'app.asar', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.loadFile(asarIndex);

  win.webContents.on('console-message', (_e, _l, msg) => note('[console] ' + msg));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  note('页面已加载');

  // 等第一页
  let ok1 = false;
  for (let i = 0; i < 80; i++) {
    const st = await win.webContents.executeJavaScript('window.__rbRendered && window.__rbRendered.page');
    if (st === 1) { ok1 = true; break; }
    await sleep(250);
  }
  note('第 1 页渲染: ' + (ok1 ? '成功' : '★ 失败'));

  // 检查是否有报错文字
  const errText = await win.webContents.executeJavaScript(`
    (() => { const s = document.getElementById('rbStatus');
      return { hidden: s?.hidden, text: s?.textContent?.trim().slice(0,120) }; })()
  `);
  note('状态层: hidden=' + errText.hidden + ' text=' + JSON.stringify(errText.text));

  // 截图 + 像素
  const img1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'packed-01.png'), img1.toPNG());
  const h1 = crypto.createHash('sha256').update(img1.toPNG()).digest('hex').slice(0,16);

  const pix1 = await win.webContents.executeJavaScript(`
    (() => { const c = document.querySelector('#rbViewer canvas'); if(!c) return null;
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0; for(let i=0;i<d.length;i+=4){ if(d[i]<240||d[i+1]<240||d[i+2]<240) n++; }
      return { w:c.width, h:c.height, ratio:+(n/(c.width*c.height)*100).toFixed(2) }; })()
  `);
  note('第1页画布: ' + (pix1 ? `${pix1.w}x${pix1.h} 非白 ${pix1.ratio}%` : '无'));

  // 点章节跳转
  const click = await win.webContents.executeJavaScript(`
    (() => { const items=[...document.querySelectorAll('.rb-item')];
      const hit=items.find(b=>b.dataset.title&&b.dataset.title.includes('第九章 魔法'));
      if(!hit) return {ok:false}; hit.click(); return {ok:true,page:hit.dataset.page}; })()
  `);
  note('点击「第九章 魔法」: ' + JSON.stringify(click));

  let ok2 = false;
  for (let i = 0; i < 80; i++) {
    const st = await win.webContents.executeJavaScript('window.__rbRendered && window.__rbRendered.page');
    if (st === Number(click.page)) { ok2 = true; break; }
    await sleep(250);
  }
  await sleep(400);
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'packed-02.png'), img2.toPNG());
  const h2 = crypto.createHash('sha256').update(img2.toPNG()).digest('hex').slice(0,16);

  const pix2 = await win.webContents.executeJavaScript(`
    (() => { const c = document.querySelector('#rbViewer canvas'); if(!c) return null;
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0; for(let i=0;i<d.length;i+=4){ if(d[i]<240||d[i+1]<240||d[i+2]<240) n++; }
      return { ratio:+(n/(c.width*c.height)*100).toFixed(2) }; })()
  `);

  note('');
  note('跳转到第 ' + click.page + ' 页: ' + (ok2 ? '成功' : '★ 失败'));
  note('画面变化: ' + (h1 !== h2 ? '是' : '★ 否') + `  (${h1} → ${h2})`);
  note('第' + click.page + '页非白像素: ' + (pix2 ? pix2.ratio + '%' : '无'));

  const pass = ok1 && ok2 && h1 !== h2 && pix1 && pix1.ratio > 1 && pix2 && pix2.ratio > 1;
  note('');
  note('=== 打包产物结论 ===');
  note(pass ? '通过：asar 内 vendor + asar 外 PDF 的组合在打包后正常工作' : '★ 未通过');

  fs.writeFileSync(path.join(OUT, 'packed-report.txt'), log.join('\n'), 'utf8');
  await sleep(300);
  app.exit(0);
});
