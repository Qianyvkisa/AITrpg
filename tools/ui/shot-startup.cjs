// ---------------------------------------------------------------------------
// 启动流程验证（开发用）
//
// 验证三件事：
//   1) 启动画面确实出现（并且在主窗口之前）
//   2) 启动画面不会永远挂着（一定会关）
//   3) 主窗口最终正常出现
//
// 用法：.dev-electron\electron.exe tools\ui\shot-startup.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(ROOT, 'tools/ui/shots');
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const T0 = Date.now();
  note('开始创建窗口');

  // 走真实的窗口创建流程
  const { createWindow } = require(path.join(ROOT, 'electron', 'window.js'));
  createWindow();

  // 轮询观察窗口状态变化
  const seen = { splash: false, main: false };
  const timeline = [];

  for (let i = 0; i < 120; i++) {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (w.isDestroyed()) continue;
      const url = w.webContents.getURL() || '';
      const t = Date.now() - T0;
      if (url.includes('splash.html') && !seen.splash) {
        seen.splash = true;
        timeline.push(`+${t}ms 启动画面出现 visible=${w.isVisible()}`);
        await sleep(120);
        try {
          const img = await w.webContents.capturePage();
          fs.writeFileSync(path.join(OUT, 'splash.png'), img.toPNG());
          note('截图 splash.png');
        } catch (e) { note('splash 截图失败: ' + e.message); }
      }
      if (url.includes('index.html') && !seen.main && w.isVisible()) {
        seen.main = true;
        timeline.push(`+${t}ms 主窗口可见`);
      }
    }
    // 主窗口可见且 splash 已消失 → 结束
    const alive = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const hasSplash = alive.some((w) => (w.webContents.getURL() || '').includes('splash.html'));
    const hasMain = alive.some((w) => (w.webContents.getURL() || '').includes('index.html'));
    if (hasMain && !hasSplash && seen.main) break;
    await sleep(150);
  }

  timeline.forEach((t) => note(t));

  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  note('剩余窗口: ' + wins.length);
  wins.forEach((w) => {
    const url = (w.webContents.getURL() || '').split('/').pop();
    note(`  ${url}  visible=${w.isVisible()}`);
  });

  const splashGone = !wins.some((w) => (w.webContents.getURL() || '').includes('splash.html'));
  note('启动画面已关闭: ' + (splashGone ? '是' : '★ 否（会一直挂着）'));
  note('主窗口已出现: ' + (seen.main ? '是' : '★ 否'));

  // 给主窗口也拍一张，确认界面不是空白
  const mainWin = wins.find((w) => (w.webContents.getURL() || '').includes('index.html'));
  if (mainWin) {
    await sleep(800);
    try {
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'main-after-startup.png'), img.toPNG());
      note('截图 main-after-startup.png');
      const st = await mainWin.webContents.executeJavaScript(`
        ({ startVisible: !document.getElementById('startScreen')?.hidden,
           menuBtns: document.querySelectorAll('.menu-btn').length })
      `);
      note('开始界面可见: ' + st.startVisible + ' / 菜单按钮数: ' + st.menuBtns);
    } catch (e) { note('主窗口截图失败: ' + e.message); }
  }

  fs.writeFileSync(path.join(OUT, 'startup-report.txt'), log.join('\n'), 'utf8');
  await sleep(300);
  app.exit(0);
});
