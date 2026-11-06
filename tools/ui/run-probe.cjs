// 渲染探针运行器（开发用）：加载 _probe.html，把探针日志打到控制台
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

app.whenReady().then(async () => {
  const { registerRuleBookIpc } = require(path.join(ROOT, 'electron', 'ipc-files.js'));
  registerRuleBookIpc();

  const win = new BrowserWindow({
    width: 1000, height: 800, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[console]', msg));
  win.webContents.on('did-fail-load', (_e, ec, desc, url) => console.log('[LOAD FAIL]', ec, desc, url));
  win.webContents.on('preload-error', (_e, p, err) => console.log('[PRELOAD ERR]', p, err.message));

  win.loadFile(path.join(ROOT, 'src', '_probe.html'));

  await new Promise((r) => win.webContents.once('did-finish-load', r));

  // 等探针跑完
  for (let i = 0; i < 60; i++) {
    const done = await win.webContents.executeJavaScript('window.__probeDone === true');
    if (done) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const lines = await win.webContents.executeJavaScript('window.__probe || ["(无输出)"]');
  console.log('=== 探针结果 ===');
  lines.forEach((l) => console.log(l));

  app.exit(0);
});
