// ---------------------------------------------------------------------------
// 在真实时钟下跑 UI 基准（开发用，不随程序分发）
//
// 为什么不用浏览器 headless：
//   --virtual-time-budget 会快进 performance.now，并且把 requestAnimationFrame
//   饿死，测出来的「渲染耗时 0ms」「2000 chunk 只写 1 次」都是假数。
//
// 为什么窗口必须真的显示：
//   隐藏窗口 / 后台窗口的 rAF 会被 Chromium 节流到 1 秒一次甚至暂停，
//   而被测代码正是靠 rAF 合帧的，窗口一藏，写入次数会被压到个位数，
//   基准就完全失真。所以这里 show:true 并关掉 backgroundThrottling。
//
// 用法：node_modules\electron\dist\electron.exe tools\ui\bench-main.cjs
//      BENCH_QUERY 可改参数，例如 chunks=2000&perFrame=20&history=300
// ---------------------------------------------------------------------------
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.BENCH_PORT || 8931);
const QUERY = process.env.BENCH_QUERY || 'chunks=2000&perFrame=20&history=300';
// 结果直接落盘：在这个 shell 里 electron 的 stdout 会被吞掉，靠日志文件才拿得到
const OUTFILE = path.resolve(process.env.BENCH_OUT || '_bench_result.json');

const log = (...a) => {
  const line = a.join(' ') + '\n';
  process.stdout.write(line);
  try {
    fs.appendFileSync(OUTFILE + '.log', line);
  } catch {}
};

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    webPreferences: {
      backgroundThrottling: false,
      offscreen: false
    }
  });

  win.webContents.on('console-message', (_e, _lvl, msg) => {
    if (String(msg).includes('benchReport') || msg.startsWith('{')) log('[page]', msg);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('LOAD FAILED', code, desc, url);
  });

  const url = `http://127.0.0.1:${PORT}/tools/ui/bench.html?${QUERY}`;
  try {
    await win.loadURL(url);
  } catch (e) {
    log('loadURL error:', String(e && e.message));
  }

  const deadline = Date.now() + 40000;
  let report = null;
  while (Date.now() < deadline) {
    report = await win.webContents
      .executeJavaScript(`document.querySelector('#benchReport')?.textContent || null`)
      .catch(() => null);
    if (report) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  log(report || 'TIMEOUT: 页面未产出报告');
  try {
    fs.writeFileSync(OUTFILE, report || 'TIMEOUT');
  } catch (e) {
    log('write failed:', String(e && e.message));
  }
  // 给写盘一点时间，再退出
  setTimeout(() => app.exit(0), 300);
});

app.on('window-all-closed', () => app.exit(0));
