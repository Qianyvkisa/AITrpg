// ---------------------------------------------------------------------------
// 启动画面遮挡诊断（开发用）
//
// 怀疑：启动画面确实创建了、也确实 isVisible()=true，
// 但主窗口比它大、又比它晚不了多久就 show 出来，
// 于是启动画面被压在下面——用户什么都看不到。
//
// 这里把两个窗口的可见性、置顶状态、矩形位置都记录下来，
// 并判断启动画面的矩形是否完全落在主窗口矩形内（被完全遮挡）。
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const T0 = Date.now();
  const { createWindow } = require(path.join(ROOT, 'electron', 'window.js'));
  createWindow();

  const rows = [];
  let coveredFrom = null;
  let splashLastSeenAt = null;

  for (let i = 0; i < 40; i++) {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const t = Date.now() - T0;
    let splash = null, main = null;
    for (const w of wins) {
      const u = w.webContents.getURL() || '';
      if (u.includes('splash.html')) splash = w;
      if (u.includes('index.html')) main = w;
    }

    const rec = {
      t,
      splashVisible: splash ? splash.isVisible() : null,
      splashTop: splash ? splash.isAlwaysOnTop() : null,
      mainVisible: main ? main.isVisible() : null,
      mainTop: main ? main.isAlwaysOnTop() : null
    };

    if (splash && main && splash.isVisible() && main.isVisible()) {
      const sb = splash.getBounds();
      const mb = main.getBounds();
      // 启动画面是否完全落在主窗口矩形内
      const inside = sb.x >= mb.x && sb.y >= mb.y &&
                     sb.x + sb.width <= mb.x + mb.width &&
                     sb.y + sb.height <= mb.y + mb.height;
      rec.splashBounds = `${sb.x},${sb.y} ${sb.width}x${sb.height}`;
      rec.mainBounds = `${mb.x},${mb.y} ${mb.width}x${mb.height}`;
      rec.fullyCovered = inside;
      if (inside && coveredFrom === null) coveredFrom = t;
    }
    if (splash && splash.isVisible()) splashLastSeenAt = t;

    rows.push(rec);
    if (!splash && main && main.isVisible()) break;
    await sleep(100);
  }

  note('=== 时间线 ===');
  for (const r of rows) {
    const parts = [`+${r.t}ms`];
    if (r.splashVisible !== null) parts.push(`splash(visible=${r.splashVisible},top=${r.splashTop})`);
    if (r.mainVisible !== null) parts.push(`main(visible=${r.mainVisible},top=${r.mainTop})`);
    if (r.fullyCovered !== undefined) parts.push(`covered=${r.fullyCovered}`);
    if (r.splashBounds) parts.push(`splashRect=${r.splashBounds} mainRect=${r.mainBounds}`);
    note(parts.join('  '));
  }

  note('');
  note('=== 判断 ===');
  note('启动画面最后可见时刻: ' + (splashLastSeenAt === null ? '从未可见' : '+' + splashLastSeenAt + 'ms'));
  note('被主窗口完全遮挡起始: ' + (coveredFrom === null ? '没有发生' : '+' + coveredFrom + 'ms'));
  if (coveredFrom !== null) {
    note('★ 结论：启动画面被主窗口盖住了。isVisible() 是 true，但用户在屏幕上看不到。');
  }

  await sleep(200);
  app.exit(0);
});
